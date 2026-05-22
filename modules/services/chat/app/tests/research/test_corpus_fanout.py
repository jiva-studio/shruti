"""Unit tests for research.corpus_fanout.

Fakes mimic the real Chunk / LibraryChunk shape just enough for
lecture_to_envelope / library_to_envelope to work — see _envelope.py.
Postgres-backed behaviour is covered by integration tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from shruti_chat.research.corpus_fanout import (
    fanout_search_with_boost,
    merge_fanout,
)
from shruti_chat.research.models import FanoutResult


# ---- fakes (shape-compatible with the real envelope functions) ------------


@dataclass
class _LecChunk:
    track_id: str
    start_ms: int
    end_ms: int
    text: str
    lang: str
    reference_source_id: str | None = None


@dataclass
class _LibChunk:
    item_id: str
    item_kind: str
    text: str
    lang: str
    addr_label: str = ""
    source_id: str = ""
    tokens: str = ""
    author_id: str | None = None
    doc_date: str | None = None
    segment_index: int = 0


@dataclass
class _Scored:
    chunk: Any
    score: float


class FakeEmbedder:
    calls = 0

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        FakeEmbedder.calls += 1
        return [[0.0] * 1536 for _ in texts]


class FakeCatalogRepo:
    async def filter_track_ids(self, **_kwargs) -> list[str] | None:
        return None


class FakeChunkRepo:
    def __init__(self, lecture_results: list[_Scored], library_results: list[_Scored]) -> None:
        self.lecture_results = lecture_results
        self.library_results = library_results

    async def search_by_embedding(self, q_vec, *, eligible_track_ids=None, lang=None, top_k=8):
        return self.lecture_results[:top_k]

    async def search_library_by_embedding(self, q_vec, *, kinds, lang=None, **kwargs):
        return [s for s in self.library_results if s.chunk.item_kind in kinds][: kwargs.get("top_k", 8)]


class FakeAliasMap:
    def __init__(self) -> None:
        self.lec_counter = 0
        self.verse_counter = 0
        self._lec: dict[tuple, int] = {}
        self._verse: dict[tuple, int] = {}

    def alias_chunk(self, track_id, start_ms, end_ms) -> int:
        key = (track_id, start_ms, end_ms)
        if key in self._lec:
            return self._lec[key]
        self.lec_counter += 1
        self._lec[key] = self.lec_counter
        return self.lec_counter

    def alias_verse(self, source_id, tokens, addr_label) -> int:
        key = (source_id, tokens)
        if key in self._verse:
            return self._verse[key]
        self.verse_counter += 1
        self._verse[key] = self.verse_counter
        return self.verse_counter

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences) -> int:
        self.verse_counter += 1
        return self.verse_counter


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_batched_embed_single_http_call():
    FakeEmbedder.calls = 0
    res = await fanout_search_with_boost(
        queries=["q1", "q2", "q3", "q4", "q5"],
        embedder=FakeEmbedder(),
        chunk_repo=FakeChunkRepo([], []),
        catalog_repo=FakeCatalogRepo(),
        alias_map=FakeAliasMap(),
    )
    assert FakeEmbedder.calls == 1
    assert res.chunks == []


@pytest.mark.asyncio
async def test_no_boost_when_ids_empty():
    repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("track_a", 0, 1000, "x", "ru"), 0.7)],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
    )
    assert len(res.chunks) == 1
    assert res.chunks[0].get("topic_boosted") is None
    assert res.chunks[0]["score"] == pytest.approx(0.7)


@pytest.mark.asyncio
async def test_boost_applied_to_matching_lecture_chunks():
    repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_boosted", 0, 1000, "x", "ru"), 0.60),
            _Scored(_LecChunk("track_normal", 0, 1000, "y", "ru"), 0.80),
        ],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        boost_ids={"track_boosted"}, boost_by_kind={"lecture": 0.15},
    )
    # Find boosted envelope by inspecting refs (ref number is per-chunk; we
    # match on text content which our fake passes through).
    by_text = {env["text"]: env for env in res.chunks}
    assert by_text["x"]["score"] == pytest.approx(0.75)
    assert by_text["x"]["topic_boosted"] is True
    assert by_text["y"]["score"] == pytest.approx(0.80)
    assert by_text["y"].get("topic_boosted") is None


@pytest.mark.asyncio
async def test_boost_can_reorder_results():
    repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_boost", 0, 1000, "BOOST", "ru"), 0.70),
            _Scored(_LecChunk("track_no", 0, 1000, "NO", "ru"), 0.78),
        ],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        boost_ids={"track_boost"}, boost_by_kind={"lecture": 0.15},
    )
    # boosted=0.85, normal=0.78 → boosted first
    assert res.chunks[0]["text"] == "BOOST"
    assert res.chunks[0]["score"] == pytest.approx(0.85)


@pytest.mark.asyncio
async def test_boost_capped_at_1():
    repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("track_x", 0, 1000, "X", "ru"), 0.96)],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        boost_ids={"track_x"}, boost_by_kind={"lecture": 0.15},
    )
    assert res.chunks[0]["score"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_relevance_floor_drops_junk():
    repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_good", 0, 1000, "GOOD", "ru"), 0.60),
            _Scored(_LecChunk("track_junk", 0, 1000, "JUNK", "ru"), 0.30),
        ],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
    )
    texts = [env["text"] for env in res.chunks]
    assert "GOOD" in texts
    assert "JUNK" not in texts


@pytest.mark.asyncio
async def test_by_kind_partition_preserved():
    repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("t", 0, 1000, "lec", "ru"), 0.7)],
        library_results=[
            _Scored(_LibChunk("verse_a", "verse", "vt", "ru", source_id="src", tokens="2.13"), 0.65),
            _Scored(_LibChunk("doc_a", "commentary", "ct", "ru", source_id="src", tokens="2.13"), 0.6),
        ],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
    )
    assert "lecture" in res.by_kind
    assert "verse" in res.by_kind
    assert "commentary" in res.by_kind


@pytest.mark.asyncio
async def test_boost_on_library_item_id():
    # Boost applies to library chunks too when their item_id is in boost_ids.
    repo = FakeChunkRepo(
        lecture_results=[],
        library_results=[
            _Scored(_LibChunk("verse_boost", "verse", "BOOST", "ru", source_id="src", tokens="2.13"), 0.55),
            _Scored(_LibChunk("verse_no", "verse", "NO", "ru", source_id="src", tokens="2.14"), 0.65),
        ],
    )
    res = await fanout_search_with_boost(
        queries=["q"], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        boost_ids={"verse_boost"}, boost_by_kind={"verse": 0.15},
    )
    by_text = {env["text"]: env for env in res.chunks}
    assert by_text["BOOST"]["score"] == pytest.approx(0.70)
    assert by_text["BOOST"]["topic_boosted"] is True


def test_merge_fanout_dedupes_by_internal_key():
    env1 = {"type": "lecture", "ref": 1, "score": 0.6, "_dedup_key": ("lecture", "t", 0, 1000)}
    env2 = {"type": "lecture", "ref": 1, "score": 0.8, "_dedup_key": ("lecture", "t", 0, 1000)}
    a = FanoutResult(chunks=[env1], by_kind={"lecture": [env1]}, max_score=0.6, rounds_executed=1)
    b = FanoutResult(chunks=[env2], by_kind={"lecture": [env2]}, max_score=0.8, rounds_executed=2)
    merged = merge_fanout(a, b)
    assert len(merged.chunks) == 1
    assert merged.chunks[0]["score"] == pytest.approx(0.8)
    assert merged.rounds_executed == 2
