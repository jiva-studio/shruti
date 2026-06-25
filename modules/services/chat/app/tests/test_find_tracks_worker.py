"""Unit tests for agent.graph.nodes.find_tracks_worker — the deterministic
lecture-search node (intent=find_track).

The worker emits everything straight to the SSE writer (no synthesizer), so
the tests capture the writer event stream and assert on its structure: the
per-lecture description + server-resolved card payload + verbatim cite, the
relevance floor, the catalog filter, and the action-before-marker ordering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import Chunk, ScoredChunk, Track


@dataclass
class _Ctx:
    embedder: Any | None = None
    chunk_repo: Any | None = None
    catalog_repo: Any | None = None
    llm: Any | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    track_display_cache: dict = field(default_factory=dict)
    lang: str = "ru"
    translate_citations: bool = False
    translator: Any | None = None
    request_id: str = "req-test"


@dataclass
class _Runtime:
    context: _Ctx


class _Embedder:
    async def embed_query(self, text: str) -> list[float]:
        return [0.1, 0.2, 0.3]


class _ChunkRepo:
    def __init__(self, results: list[list[ScoredChunk]]) -> None:
        self._results = results
        self.calls = 0

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        i = min(self.calls, len(self._results) - 1)
        self.calls += 1
        return self._results[i]


def _track(tid: str, title: str | None) -> Track:
    return Track(
        id=tid, title=title, lang="ru", date="1976-01-01",
        author_id="a1", author_name="Prabhupada", location_id=None, location_name=None,
        tag_ids=(), tag_names=(), duration_ms=None, references=(),
    )


class _Catalog:
    def __init__(self, *, titles=None, descriptions=None, eligible=None) -> None:
        self._titles = titles or {}
        self._descriptions = descriptions or {}
        self._eligible = eligible

    async def filter_track_ids(self, **kwargs):
        return self._eligible

    async def get_outline(self, track_id, lang):
        return ("[]", self._descriptions.get(track_id))

    async def get_track(self, track_id, *, lang):
        # A track absent from `_titles` is "not in the published catalog".
        if track_id not in self._titles:
            return None
        return _track(track_id, self._titles[track_id])

    async def resolve(self, kind, text, *, lang, limit):
        return []


class _FakeLLM:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        self.calls.append(run_name or "")
        return schema(text=f"prose[{run_name}]")


def _sc(track_id: str, start: int, score: float, text: str) -> ScoredChunk:
    return ScoredChunk(
        chunk=Chunk(
            track_id=track_id, lang="ru", start_ms=start, end_ms=start + 1000,
            text=text, reference_source_id=None,
        ),
        score=score,
    )


@pytest.fixture
def _events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []
    monkeypatch.setattr(ftw, "get_stream_writer", lambda: captured.append)
    return captured


async def test_emits_description_card_and_verbatim_quote(_events) -> None:
    chunks = [
        _sc("t1", 65000, 0.7, "t1 weaker"),
        _sc("t1", 70000, 0.9, "t1 best quote"),
        _sc("t2", 80000, 0.6, "t2 quote"),
    ]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция А", "t2": "Лекция Б"},
            descriptions={"t1": "описание А", "t2": "описание Б"},
        ),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "очищение сердца", "extracted_args": {}}, _Runtime(ctx)
    )
    assert out == {}

    actions = [e for e in _events if e["type"] == "action"]
    cite_actions = [a for a in actions if a["data"]["kind"] == "cite_transcript"]
    card_actions = [a for a in actions if a["data"]["kind"] == "card"]

    # One card + one cite per lecture, ranked t1 then t2, verbatim quote text.
    assert [a["data"]["payload"]["track_id"] for a in card_actions] == ["t1", "t2"]
    assert [a["data"]["payload"].get("track_title") for a in card_actions] == ["Лекция А", "Лекция Б"]
    assert [a["data"]["payload"]["text"] for a in cite_actions] == ["t1 best quote", "t2 quote"]

    full = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[card:t1]" in full and "[card:t2]" in full
    assert "[cite:t1@70000-71000]" in full
    assert "###" not in full  # descriptions are paragraphs, NOT headings

    llm: _FakeLLM = ctx.llm
    assert "find_tracks_intro" in llm.calls
    assert llm.calls.count("find_tracks_description") == 2


async def test_card_and_cite_actions_precede_their_markers(_events) -> None:
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "quote")]]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    kinds = [(e["type"], e["data"].get("kind")) for e in _events]
    card_idx = kinds.index(("action", "card"))
    cite_idx = kinds.index(("action", "cite_transcript"))
    marker_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "delta" and "[card:t1]" in e["data"]["text"]
    )
    assert card_idx < marker_idx and cite_idx < marker_idx


async def test_below_floor_results_dropped(_events) -> None:
    # Best chunk 0.30 < _MIN_SCORE → no lectures → just the empty intro line.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.30, "weak")]]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    assert not [e for e in _events if e["type"] == "action"]


async def test_uncatalogued_track_dropped(_events) -> None:
    # t1 is in the catalog, t2 is NOT (no title) → only t1 surfaces.
    chunks = [_sc("t1", 70000, 0.9, "q1"), _sc("t2", 70000, 0.8, "q2")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция А"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["t1"]


async def test_prefers_non_intro_chunk_for_quote(_events) -> None:
    # Higher-scoring intro chunk (start<60s) vs lower non-intro one → quote the
    # non-intro passage; relevance still uses the track's best score.
    chunks = [_sc("t1", 5000, 0.95, "intro boilerplate"), _sc("t1", 90000, 0.7, "real passage")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    cite = next(e for e in _events if e["type"] == "action" and e["data"]["kind"] == "cite_transcript")
    assert cite["data"]["payload"]["text"] == "real passage"
