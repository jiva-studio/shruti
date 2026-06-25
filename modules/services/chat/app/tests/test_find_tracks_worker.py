"""Unit tests for agent.graph.nodes.find_tracks_worker — the deterministic
lecture-search node (intent=find_track).

The worker emits everything straight to the SSE writer (no synthesizer), so
the tests capture the writer event stream and assert on its structure:
verbatim cite payloads, the action-before-marker ordering, and the
group-by-track ranking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import Chunk, ScoredChunk


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
        # One list per successive search() call (for relaxation tests).
        self._results = results
        self.calls = 0

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        i = min(self.calls, len(self._results) - 1)
        self.calls += 1
        return self._results[i]


class _Catalog:
    def __init__(self, *, titles=None, descriptions=None, eligible=None) -> None:
        self._titles = titles or {}
        self._descriptions = descriptions or {}
        self._eligible = eligible  # return value of filter_track_ids

    async def filter_track_ids(self, **kwargs):
        return self._eligible

    async def get_titles(self, track_ids, *, lang):
        return {t: self._titles[t] for t in track_ids if t in self._titles}

    async def get_outline(self, track_id, lang):
        return ("[]", self._descriptions.get(track_id))

    async def get_track(self, track_id, *, lang):
        return None  # → resolve_track_display returns {} (fine for the test)

    async def resolve(self, kind, text, *, lang, limit):
        return []


class _FakeLLM:
    """structured_output returns an instance of the requested schema with a
    deterministic header derived from the user message."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        self.calls.append(run_name or "")
        return schema(text=f"header[{run_name}]")


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


async def test_emits_cards_and_verbatim_quotes_grouped_by_track(_events) -> None:
    # t1 has two chunks (best=0.9 wins); t2 one chunk. Ranked t1, t2.
    chunks = [
        _sc("t1", 1000, 0.7, "t1 weaker"),
        _sc("t1", 5000, 0.9, "t1 best quote"),
        _sc("t2", 2000, 0.6, "t2 quote"),
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
    deltas = [e for e in _events if e["type"] == "delta"]
    cite_actions = [a for a in actions if a["data"]["kind"] == "cite_transcript"]

    # One cite per lecture, best chunk's verbatim text, ranked t1 then t2.
    assert [a["data"]["payload"]["track_id"] for a in cite_actions] == ["t1", "t2"]
    assert [a["data"]["payload"]["text"] for a in cite_actions] == ["t1 best quote", "t2 quote"]

    full = "".join(d["data"]["text"] for d in deltas)
    # Tappable lecture tile + the quote marker for each lecture.
    assert "[card:t1]" in full and "[card:t2]" in full
    assert "[cite:t1@5000-6000]" in full
    assert "[cite:t2@2000-3000]" in full
    # A global header + one header per lecture were generated.
    llm: _FakeLLM = ctx.llm
    assert "find_tracks_global_header" in llm.calls
    assert llm.calls.count("find_tracks_header") == 2


async def test_action_emitted_before_its_marker(_events) -> None:
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 5000, 0.9, "quote")]]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "x", "extracted_args": {}}, _Runtime(ctx)
    )
    # Ordering invariant: the cite_transcript action precedes the delta that
    # carries its [cite:...] marker.
    cite_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "action" and e["data"]["kind"] == "cite_transcript"
    )
    marker_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "delta" and "[cite:t1@5000-6000]" in e["data"]["text"]
    )
    assert cite_idx < marker_idx


async def test_empty_result_emits_single_localized_line(_events) -> None:
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "ничего", "extracted_args": {}}, _Runtime(ctx)
    )
    assert out == {}
    assert not [e for e in _events if e["type"] == "action"]
    deltas = [e for e in _events if e["type"] == "delta"]
    assert len(deltas) == 1  # just the "not found" line
    assert "header[find_tracks_global_header]" in deltas[0]["data"]["text"]


async def test_progressive_relaxation_drops_filters(_events) -> None:
    # First (filtered) search empty; relaxed search returns a lecture.
    repo = _ChunkRepo([[], [_sc("t1", 1000, 0.8, "quote")]])
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=repo,
        catalog_repo=_Catalog(
            titles={"t1": "Лекция"}, descriptions={"t1": "d"}, eligible=["t1"],
        ),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "преданность", "extracted_args": {"year": 1976}}, _Runtime(ctx)
    )
    assert repo.calls == 2  # constrained then relaxed
    cite_actions = [
        e for e in _events
        if e["type"] == "action" and e["data"]["kind"] == "cite_transcript"
    ]
    assert len(cite_actions) == 1
