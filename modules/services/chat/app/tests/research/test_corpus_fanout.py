"""Unit tests for research.corpus_fanout.

Fakes mimic the real Chunk / LibraryChunk shape just enough for
lecture_to_envelope / library_to_envelope to work — see _envelope.py.
Postgres-backed behaviour is covered by integration tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from lectorium_chat.research.corpus_fanout import (
    _label_for_library_chunk,
    fanout_search_with_boost,
    merge_fanout,
)
from lectorium_chat.research.models import FanoutResult


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


class FakeReranker:
    """Preserves the cosine order it's given (the pool is pre-sorted by cosine
    before rerank), so the top-K cut == top-K by cosine. Lets the reserve tests
    isolate "verses squeezed out of the cut" from cross-encoder quirks."""

    async def rerank(self, query: str, texts: list[str], top_k: int | None = None):
        return [(i, 1.0 - i * 0.001) for i in range(len(texts))]


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
        queries=[(0, "q1"), (1, "q2"), (2, "q3"), (3, "q4"), (4, "q5")],
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
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
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        boost_ids={"verse_boost"}, boost_by_kind={"verse": 0.15},
    )
    by_text = {env["text"]: env for env in res.chunks}
    assert by_text["BOOST"]["score"] == pytest.approx(0.70)
    assert by_text["BOOST"]["topic_boosted"] is True


# ---- per-family rerank reserve (1c) ---------------------------------------


def _lec(i: int, score: float) -> _Scored:
    return _Scored(_LecChunk(f"track_{i}", 0, 1000, f"lec_{i}", "ru"), score)


def _verse(i: int, score: float) -> _Scored:
    return _Scored(
        _LibChunk(f"verse_{i}", "verse", f"verse_{i}", "ru", source_id="BG", tokens=f"2.{i}"),
        score,
    )


@pytest.mark.asyncio
async def test_rerank_reserve_seats_verses_squeezed_out_of_topk():
    # 18 lectures dominate the top-16 cut; 3 verses sit just below them but
    # clear RERANK_RESERVE_FLOOR (0.40). Without the reserve verses = 0; with
    # it, ≥RERANK_MIN_VERSES verses survive while lectures are untouched.
    repo = FakeChunkRepo(
        lecture_results=[_lec(i, 0.60) for i in range(18)],
        library_results=[_verse(i, 0.45) for i in range(3)],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        reranker=FakeReranker(), rerank_query="q",
    )
    verses = res.by_kind.get("verse", [])
    lectures = res.by_kind.get("lecture", [])
    assert len(verses) >= 2, "verse reserve should seat ≥2 verses past the cut"
    assert len(lectures) == 16, "lecture cut (top-K) must be unaffected"


@pytest.mark.asyncio
async def test_rerank_reserve_skips_low_cosine_verses():
    # Verses below RERANK_RESERVE_FLOOR (0.30 < 0.40) are NOT force-included —
    # empty-result discipline: never promote junk just to fill a quota.
    repo = FakeChunkRepo(
        lecture_results=[_lec(i, 0.60) for i in range(18)],
        library_results=[_verse(i, 0.30) for i in range(3)],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        reranker=FakeReranker(), rerank_query="q",
    )
    assert res.by_kind.get("verse", []) == []


# ---- _label_for_library_chunk (issue #660) --------------------------------


def test_label_uses_addr_label_when_present():
    c = _LibChunk(
        item_id="verse_abc", item_kind="verse", text="t", lang="ru",
        addr_label="BG 2.13", source_id="BG", tokens="2.13",
    )
    assert _label_for_library_chunk(c) == "BG 2.13"


def test_label_strips_whitespace_in_addr_label():
    c = _LibChunk(
        item_id="verse_abc", item_kind="verse", text="t", lang="ru",
        addr_label="  BG 2.13  ", source_id="BG", tokens="2.13",
    )
    assert _label_for_library_chunk(c) == "BG 2.13"


def test_label_composes_from_source_and_tokens_when_addr_label_empty():
    """Issue #660: addr_label missing — must NOT fall back to `item_id`
    (raw UUID like `verse_<uuid>`). Compose a short form from source+tokens."""
    c = _LibChunk(
        item_id="verse_abc-uuid", item_kind="verse", text="t", lang="ru",
        addr_label="", source_id="BG", tokens="2.13",
    )
    assert _label_for_library_chunk(c) == "BG 2.13"
    assert "verse_abc-uuid" not in _label_for_library_chunk(c)


def test_label_composes_from_source_and_tokens_for_commentary():
    c = _LibChunk(
        item_id="doc_xyz-uuid", item_kind="commentary", text="t", lang="ru",
        addr_label="", source_id="SB", tokens="1.1.1",
    )
    assert _label_for_library_chunk(c) == "SB 1.1.1"


def test_label_falls_back_to_source_only():
    c = _LibChunk(
        item_id="doc_xyz", item_kind="prose_chapter", text="t", lang="ru",
        addr_label="", source_id="NoI", tokens="",
    )
    assert _label_for_library_chunk(c) == "NoI"


def test_label_letter_with_date_only():
    c = _LibChunk(
        item_id="doc_xyz", item_kind="letter", text="t", lang="en",
        addr_label="", source_id="", tokens="", doc_date="1972-10-04",
    )
    assert _label_for_library_chunk(c) == "Letter, 1972-10-04"


def test_label_letter_with_nothing():
    c = _LibChunk(
        item_id="doc_xyz", item_kind="letter", text="t", lang="en",
        addr_label="", source_id="", tokens="",
    )
    assert _label_for_library_chunk(c) == "Letter"


def test_label_generic_verse_fallback_when_metadata_missing():
    """All metadata missing → generic localized label, NEVER `item_id`."""
    c = _LibChunk(
        item_id="verse_abc-uuid", item_kind="verse", text="t", lang="ru",
        addr_label="", source_id="", tokens="",
    )
    label = _label_for_library_chunk(c)
    assert label == "verse"
    assert "verse_abc-uuid" not in label


def test_label_generic_library_doc_fallback_when_metadata_missing():
    c = _LibChunk(
        item_id="doc_abc-uuid", item_kind="commentary", text="t", lang="ru",
        addr_label="", source_id="", tokens="",
    )
    label = _label_for_library_chunk(c)
    assert label == "library document"
    assert "doc_abc-uuid" not in label


def test_merge_fanout_dedupes_by_internal_key():
    env1 = {"type": "lecture", "ref": 1, "score": 0.6, "_dedup_key": ("lecture", "t", 0, 1000)}
    env2 = {"type": "lecture", "ref": 1, "score": 0.8, "_dedup_key": ("lecture", "t", 0, 1000)}
    a = FanoutResult(chunks=[env1], by_kind={"lecture": [env1]}, max_score=0.6, rounds_executed=1)
    b = FanoutResult(chunks=[env2], by_kind={"lecture": [env2]}, max_score=0.8, rounds_executed=2)
    merged = merge_fanout(a, b)
    assert len(merged.chunks) == 1
    assert merged.chunks[0]["score"] == pytest.approx(0.8)
    assert merged.rounds_executed == 2
