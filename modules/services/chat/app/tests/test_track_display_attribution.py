"""Tests for server-resolved card display attribution.

A thin client (web) holds no local catalog, so the server resolves a cited
track's title / author / date / references and ships them on the card
payload. `resolve_track_display` localizes to the answer language, caches
per-turn, and degrades to {} on any miss so the card still renders.
"""

from __future__ import annotations

import pytest

import shruti_chat.agent.graph.nodes._worker_common as wc
from shruti_chat.agent.graph.nodes._worker_common import (
    _format_reference_label,
    flush_card_payloads,
    resolve_track_display,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.domain.entities import Reference, Track


def _track(**kw) -> Track:
    defaults = dict(
        id="t1",
        title="The Goal of Life",
        lang="en",
        date="1972-08-14",
        author_id="a1",
        author_name="A. C. Bhaktivedanta Swami",
        location_id="l1",
        location_name="Los Angeles",
        tag_ids=(),
        tag_names=(),
        duration_ms=1000,
        references=(
            Reference(source_id="bg", full_name="Bhagavad-gītā", short_name="BG", tokens="4.8"),
        ),
    )
    defaults.update(kw)
    return Track(**defaults)


class FakeCatalogRepo:
    """Records get_track calls and replays a canned track (or raises)."""

    def __init__(self, track: Track | None, *, boom: bool = False) -> None:
        self._track = track
        self._boom = boom
        self.calls: list[tuple[str, str]] = []

    async def get_track(self, track_id: str, *, lang: str) -> Track | None:
        self.calls.append((track_id, lang))
        if self._boom:
            raise RuntimeError("db down")
        return self._track


@pytest.fixture
def capture_writer(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(wc, "get_stream_writer", lambda: events.append)
    return events


# ── _format_reference_label ───────────────────────────────────────────────


def test_format_reference_label_short_and_tokens() -> None:
    ref = Reference(source_id="bg", full_name="Bhagavad-gītā", short_name="BG", tokens="4.8")
    assert _format_reference_label(ref) == "BG 4.8"


def test_format_reference_label_no_tokens() -> None:
    ref = Reference(source_id="bg", full_name="Bhagavad-gītā", short_name="BG", tokens=None)
    assert _format_reference_label(ref) == "BG"


def test_format_reference_label_falls_back_to_source_id() -> None:
    ref = Reference(source_id="bg", full_name=None, short_name=None, tokens="4.8")
    assert _format_reference_label(ref) == "bg 4.8"


# ── resolve_track_display ─────────────────────────────────────────────────


async def test_resolve_track_display_full() -> None:
    repo = FakeCatalogRepo(_track())
    ctx = TurnContext(lang="ru", catalog_repo=repo)
    out = await resolve_track_display(ctx, "t1")
    assert out["track_title"] == "The Goal of Life"
    assert out["author_name"] == "A. C. Bhaktivedanta Swami"
    assert out["date"] == "1972-08-14"
    assert out["references"] == [{"source_id": "bg", "tokens": "4.8", "label": "BG 4.8"}]
    # Resolved in the content language the answer locale reduces to (ru→ru).
    assert repo.calls == [("t1", "ru")]


async def test_resolve_track_display_collapses_uk_to_ru() -> None:
    # Catalog name dicts exist only in en/ru, so a uk answer must resolve in
    # the collapsed content language (uk→ru) — otherwise the join finds no
    # uk rows and the web card renders the raw catalog id ("source_… 2.19").
    repo = FakeCatalogRepo(_track())
    ctx = TurnContext(lang="uk", catalog_repo=repo)
    out = await resolve_track_display(ctx, "t1")
    assert out["references"] == [{"source_id": "bg", "tokens": "4.8", "label": "BG 4.8"}]
    assert repo.calls == [("t1", "ru")]  # collapsed, not the raw "uk"


async def test_resolve_track_display_collapses_sr_to_en() -> None:
    # A non-East-Slavic non-corpus locale reduces to English.
    repo = FakeCatalogRepo(_track())
    ctx = TurnContext(lang="sr-Cyrl", catalog_repo=repo)
    await resolve_track_display(ctx, "t1")
    assert repo.calls == [("t1", "en")]


async def test_resolve_track_display_caches_per_turn() -> None:
    repo = FakeCatalogRepo(_track())
    ctx = TurnContext(lang="ru", catalog_repo=repo)
    await resolve_track_display(ctx, "t1")
    await resolve_track_display(ctx, "t1")
    assert repo.calls == [("t1", "ru")]  # second call served from cache


async def test_resolve_track_display_no_repo() -> None:
    ctx = TurnContext(lang="ru", catalog_repo=None)
    assert await resolve_track_display(ctx, "t1") == {}


async def test_resolve_track_display_unknown_track() -> None:
    repo = FakeCatalogRepo(None)
    ctx = TurnContext(lang="ru", catalog_repo=repo)
    assert await resolve_track_display(ctx, "t1") == {}


async def test_resolve_track_display_swallows_error() -> None:
    repo = FakeCatalogRepo(_track(), boom=True)
    ctx = TurnContext(lang="ru", catalog_repo=repo)
    assert await resolve_track_display(ctx, "t1") == {}


async def test_resolve_track_display_omits_empty_fields() -> None:
    repo = FakeCatalogRepo(_track(title=None, author_name=None, date=None, references=()))
    ctx = TurnContext(lang="ru", catalog_repo=repo)
    assert await resolve_track_display(ctx, "t1") == {}


# ── integration: the eager cite flush carries the attribution ─────────────


class FakeChunkRepo:
    def __init__(self, text: str) -> None:
        self.text = text

    async def get_chunk_text_exact(self, track_id, *, start_ms, end_ms, lang) -> str:
        return self.text


async def test_flush_cite_includes_attribution(capture_writer) -> None:
    ctx = TurnContext(
        lang="ru",
        chunk_repo=FakeChunkRepo("snippet"),
        catalog_repo=FakeCatalogRepo(_track()),
    )
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="ru")
    ctx.aliases.chunk_texts[n] = "snippet"

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert payload["track_id"] == "t1"  # id still shipped — mobile uses it
    assert payload["text"] == "snippet"
    assert payload["track_title"] == "The Goal of Life"
    assert payload["author_name"] == "A. C. Bhaktivedanta Swami"
    assert payload["date"] == "1972-08-14"
    assert payload["references"][0]["label"] == "BG 4.8"
