"""Tests for `flush_cite_payloads` — the on-demand transcript re-fetch.

A cited fragment renders as a full quote card on the client only if a
`cite_transcript` SSE payload precedes its `[cite:...]` marker. The text
comes from `aliases.chunk_texts` when it was stashed at mint time
(`lecture_to_envelope`), and is re-fetched by EXACT bounds otherwise (the
pre-minted focus fragment, history-restored refs). The fetch must be
exact — never an overlap query — so the snippet matches the cited
[start_ms, end_ms] window rather than bleeding in overlapping chunks.
"""

from __future__ import annotations

import pytest

import shruti_chat.agent.graph.nodes._worker_common as wc
from shruti_chat.agent.graph.nodes._worker_common import (
    _fetch_cite_text,
    flush_cite_payloads,
)
from shruti_chat.domain.turn_context import TurnContext


class FakeChunkRepo:
    """Records get_chunk_text_exact calls and replays a canned answer."""

    def __init__(self, text: str | None) -> None:
        self.text = text
        self.calls: list[dict] = []

    async def get_chunk_text_exact(
        self, track_id, *, start_ms, end_ms, lang
    ) -> str | None:
        self.calls.append(
            {"track_id": track_id, "start_ms": start_ms, "end_ms": end_ms, "lang": lang}
        )
        return self.text


@pytest.fixture
def capture_writer(monkeypatch):
    """Patch get_stream_writer so flush_cite_payloads' emits land in a list."""
    events: list[dict] = []
    monkeypatch.setattr(wc, "get_stream_writer", lambda: events.append)
    return events


async def test_fetch_cite_text_returns_exact_text() -> None:
    repo = FakeChunkRepo("  exact snippet  ")
    ctx = TurnContext(chunk_repo=repo)
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    text = await _fetch_cite_text(ctx, cref)
    assert text == "exact snippet"
    # Looked up by EXACT bounds + lang — not an overlap window.
    assert repo.calls == [{"track_id": "t1", "start_ms": 1000, "end_ms": 2000, "lang": "en"}]


async def test_fetch_cite_text_no_repo_returns_empty() -> None:
    ctx = TurnContext(chunk_repo=None)
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    assert await _fetch_cite_text(ctx, cref) == ""


async def test_fetch_cite_text_no_row_returns_empty() -> None:
    # Exact lookup misses (e.g. a focus span that isn't a chunk boundary) —
    # degrade to the chip, never to over-broad overlapping text.
    repo = FakeChunkRepo(None)
    ctx = TurnContext(chunk_repo=repo)
    cref = wc.ChunkRef(track_id="t1", start_ms=1234, end_ms=5678, lang=None)
    assert await _fetch_cite_text(ctx, cref) == ""


async def test_fetch_cite_text_swallows_repo_error() -> None:
    class Boom:
        async def get_chunk_text_exact(self, *a, **k):
            raise RuntimeError("db down")

    ctx = TurnContext(chunk_repo=Boom())
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    assert await _fetch_cite_text(ctx, cref) == ""


async def test_flush_prefers_stashed_chunk_text(capture_writer) -> None:
    """When the text was stashed at mint, no DB re-fetch happens."""
    repo = FakeChunkRepo("should-not-be-used")
    ctx = TurnContext(chunk_repo=repo)
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")
    ctx.aliases.chunk_texts[n] = "stashed snippet"

    await flush_cite_payloads(ctx)

    assert repo.calls == []  # stashed text wins; no re-fetch
    assert len(capture_writer) == 1
    payload = capture_writer[0]["data"]["payload"]
    assert payload["text"] == "stashed snippet"
    assert payload["track_id"] == "t1"
    assert payload["start_ms"] == 1000
    assert payload["end_ms"] == 2000
    assert n in ctx.emitted_cite_refs


async def test_flush_refetches_when_text_missing(capture_writer) -> None:
    """Focus / history aliases have no stashed text — the snippet is
    re-fetched by exact bounds so the card still renders the right text."""
    repo = FakeChunkRepo("re-fetched snippet")
    ctx = TurnContext(chunk_repo=repo)
    n = ctx.aliases.alias_chunk("t9", 5000, 6000, lang="ru")
    # no chunk_texts entry

    await flush_cite_payloads(ctx)

    assert repo.calls == [{"track_id": "t9", "start_ms": 5000, "end_ms": 6000, "lang": "ru"}]
    assert len(capture_writer) == 1
    assert capture_writer[0]["data"]["payload"]["text"] == "re-fetched snippet"


async def test_flush_skips_when_fetch_empty(capture_writer) -> None:
    """A genuine miss (no exact row) degrades to the chip — no event."""
    repo = FakeChunkRepo(None)
    ctx = TurnContext(chunk_repo=repo)
    ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")

    await flush_cite_payloads(ctx)

    assert capture_writer == []
