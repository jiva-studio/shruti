"""Tests for `flush_cite_payloads` — the on-demand transcript re-fetch.

A cited fragment renders as a full quote card on the client only if a
`cite_transcript` SSE payload precedes its `[cite:...]` marker. The text
comes from `aliases.chunk_texts` when the research pipeline stashed it,
and is re-fetched from the chunk repo otherwise (fragments aliased by a
ReAct worker, the focus fragment, or round-tripped from a prior turn).
"""

from __future__ import annotations

import pytest

import lectorium_chat.agent.graph.nodes._worker_common as wc
from lectorium_chat.agent.graph.nodes._worker_common import (
    _fetch_cite_text,
    flush_cite_payloads,
)
from lectorium_chat.domain.turn_context import TurnContext


class FakeChunkRepo:
    """Records get_anchor_texts calls and replays a canned answer."""

    def __init__(self, rows: list[str]) -> None:
        self.rows = rows
        self.calls: list[dict] = []

    async def get_anchor_texts(
        self, track_id, *, start_ms, end_ms, lang, limit
    ) -> list[str]:
        self.calls.append(
            {"track_id": track_id, "start_ms": start_ms, "end_ms": end_ms, "lang": lang}
        )
        return self.rows


@pytest.fixture
def capture_writer(monkeypatch):
    """Patch get_stream_writer so flush_cite_payloads' emits land in a list."""
    events: list[dict] = []
    monkeypatch.setattr(wc, "get_stream_writer", lambda: events.append)
    return events


async def test_fetch_cite_text_joins_and_strips() -> None:
    repo = FakeChunkRepo(["  first  ", "second", "", "  "])
    ctx = TurnContext(chunk_repo=repo)
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    text = await _fetch_cite_text(ctx, cref)
    assert text == "first second"
    assert repo.calls == [{"track_id": "t1", "start_ms": 1000, "end_ms": 2000, "lang": "en"}]


async def test_fetch_cite_text_no_repo_returns_empty() -> None:
    ctx = TurnContext(chunk_repo=None)
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    assert await _fetch_cite_text(ctx, cref) == ""


async def test_fetch_cite_text_swallows_repo_error() -> None:
    class Boom:
        async def get_anchor_texts(self, *a, **k):
            raise RuntimeError("db down")

    ctx = TurnContext(chunk_repo=Boom())
    cref = wc.ChunkRef(track_id="t1", start_ms=1000, end_ms=2000, lang="en")
    assert await _fetch_cite_text(ctx, cref) == ""


async def test_flush_prefers_stashed_chunk_text(capture_writer) -> None:
    """When research already stashed the text, no DB re-fetch happens."""
    repo = FakeChunkRepo(["should-not-be-used"])
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
    """ReAct-worker / focus / history aliases have no stashed text — the
    snippet is re-fetched on demand so the card still renders."""
    repo = FakeChunkRepo(["re-fetched snippet"])
    ctx = TurnContext(chunk_repo=repo)
    n = ctx.aliases.alias_chunk("t9", 5000, 6000, lang="ru")
    # no chunk_texts entry

    await flush_cite_payloads(ctx)

    assert repo.calls == [{"track_id": "t9", "start_ms": 5000, "end_ms": 6000, "lang": "ru"}]
    assert len(capture_writer) == 1
    assert capture_writer[0]["data"]["payload"]["text"] == "re-fetched snippet"


async def test_flush_skips_when_fetch_empty(capture_writer) -> None:
    """A genuine miss (DB returns nothing) degrades to the chip — no event."""
    repo = FakeChunkRepo([])
    ctx = TurnContext(chunk_repo=repo)
    ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")

    await flush_cite_payloads(ctx)

    assert capture_writer == []
