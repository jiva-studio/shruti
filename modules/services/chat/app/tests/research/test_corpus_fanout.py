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
    _fmt_timecode,
    _label_for_lecture_chunk,
    _label_for_library_chunk,
    _parse_addresses,
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

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return await self.embed_documents(texts)


class FakeCatalogRepo:
    def __init__(self, author_names: dict[str, str] | None = None) -> None:
        self._author_names = author_names or {}

    async def filter_track_ids(self, **_kwargs) -> list[str] | None:
        return None

    async def get_author_names(self, ids, *, lang=None) -> dict[str, str]:
        return {i: self._author_names[i] for i in ids if i in self._author_names}


class FakeChunkRepo:
    def __init__(
        self,
        lecture_results: list[_Scored],
        library_results: list[_Scored],
        lexical_results: list[_Scored] | None = None,
        addr_results: dict[str, list[Any]] | None = None,
    ) -> None:
        self.lecture_results = lecture_results
        self.library_results = library_results
        self.lexical_results = lexical_results or []
        self.addr_results = addr_results or {}
        self.lexical_calls = 0

    async def search_by_embedding(self, q_vec, *, eligible_track_ids=None, lang=None, top_k=8):
        return self.lecture_results[:top_k]

    async def search_library_by_embedding(self, q_vec, *, kinds, lang=None, **kwargs):
        return [s for s in self.library_results if s.chunk.item_kind in kinds][: kwargs.get("top_k", 8)]

    async def search_chunks_lexical(self, query_text, query_embedding, *, kinds, **kwargs):
        self.lexical_calls += 1
        return [s for s in self.lexical_results if s.chunk.item_kind in kinds][: kwargs.get("top_k", 24)]

    async def get_chunks_by_addr_label(self, addr_label, *, kinds, lang=None):
        return [c for c in self.addr_results.get(addr_label, []) if c.item_kind in kinds]


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
        # `lecture_to_envelope` stashes the exact chunk text here at mint.
        self.chunk_texts: dict[int, str] = {}
        # Records author_name passed to alias_commentary (for assertions).
        self.commentary_authors: dict[str, str | None] = {}
        # Records the MediaRef payload passed to alias_media (for assertions).
        self.media_aliases: dict[str, dict[str, Any]] = {}

    def alias_chunk(self, track_id, start_ms, end_ms, lang=None) -> int:
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

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences, kind="commentary") -> int:
        self.verse_counter += 1
        self.commentary_authors[item_id] = author_name
        return self.verse_counter

    def alias_media(self, item_id, *, label, text="", lang=None) -> int:
        self.verse_counter += 1
        # Record what reached the MediaRef so the test can assert the alias
        # carries the playable id + display label/text (flush_media resolves
        # the rest from library_media at turn time).
        self.media_aliases[item_id] = {"label": label, "text": text, "lang": lang}
        return self.verse_counter


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_fanout_commentary_resolves_author_name():
    """A commentary surfaced by fanout cites with the resolved author name
    (from catalog), not a bare address — same as the SHORT-path expansion."""
    chunk = _LibChunk(
        item_id="doc_purport", item_kind="commentary", text="Первое. Второе.",
        lang="ru", addr_label="ШБ 4.1.39", source_id="src",
        tokens="4.1.39", author_id="author_prabhupada", segment_index=0,
    )
    alias_map = FakeAliasMap()
    res = await fanout_search_with_boost(
        queries=[(0, "q")],
        embedder=FakeEmbedder(),
        chunk_repo=FakeChunkRepo([], [_Scored(chunk, 0.7)]),
        catalog_repo=FakeCatalogRepo(
            {"author_prabhupada": "А.Ч. Бхактиведанта Свами Прабхупада"}
        ),
        alias_map=alias_map,
        lang="ru",
    )
    assert len(res.chunks) == 1
    # The resolved author name reached alias_commentary (→ blockquote attribution).
    assert alias_map.commentary_authors["doc_purport"] == "А.Ч. Бхактиведанта Свами Прабхупада"


@pytest.mark.asyncio
async def test_fanout_surfaces_media_chunk_as_citable_note():
    """A media clip (item_kind='media') retrieved by fanout must:
      1. emit a live `research_source` of kind='media' (not library_doc),
      2. survive dedup/rerank into the returned notes as type='media',
      3. mint a MediaRef alias that the marker expander unfolds to
         `[media:<id>|caption]` — exactly the path verse/library kinds take.

    Uses the REAL TurnAliasMap + MarkerExpander so the assertion proves the
    end-to-end thread, not just the mock surface. flush_media (tested
    separately) resolves url/type/speaker from library_media at turn time;
    here the alias only needs to carry item_id + label + text."""
    from lectorium_chat.agent.marker_expander import MarkerExpander
    from lectorium_chat.agent.turn_aliases import MediaRef, TurnAliasMap

    chunk = _LibChunk(
        item_id="fsp-1-en-010-spk7", item_kind="media",
        text="I remember when Srila Prabhupada arrived in Bombay…",
        lang="en", addr_label="Hari Sauri · 1976",
        source_id="", tokens="", segment_index=0,
    )
    alias_map = TurnAliasMap()
    events: list[tuple[str, dict[str, Any]]] = []

    def on_event(event_type: str, data: dict[str, Any]) -> None:
        events.append((event_type, data))

    res = await fanout_search_with_boost(
        queries=[(0, "remembrances of Prabhupada in Bombay")],
        embedder=FakeEmbedder(),
        chunk_repo=FakeChunkRepo([], [_Scored(chunk, 0.7)]),
        catalog_repo=FakeCatalogRepo(),
        alias_map=alias_map,
        lang="en",
        on_event=on_event,
    )

    # 1. Live research_source — its own `media` kind + `media:<id>` namespace.
    media_sources = [
        d for (t, d) in events
        if t == "research_source" and d.get("kind") == "media"
    ]
    assert media_sources, "media chunk must surface a research_source of kind='media'"
    assert media_sources[0]["id"] == "media:fsp-1-en-010-spk7"
    assert media_sources[0]["label"] == "Hari Sauri · 1976"

    # 2. Citable note survives into the returned set as type='media'.
    media_notes = [e for e in res.chunks if e.get("type") == "media"]
    assert len(media_notes) == 1, "media chunk must survive dedup/rerank as a note"
    note = media_notes[0]
    assert "media" in res.by_kind

    # 3. The note's ref is a MediaRef alias that expands to a [media:...] marker.
    ref = note["ref"]
    assert isinstance(ref, int)
    resolved = alias_map.resolve(ref)
    assert isinstance(resolved, MediaRef)
    assert resolved.item_id == "fsp-1-en-010-spk7"

    expander = MarkerExpander(alias_map)
    expanded = await expander.feed(f"clip here [^{ref}]") + await expander.flush()
    assert expanded == "clip here [media:fsp-1-en-010-spk7|Hari Sauri · 1976]"


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
async def test_single_chunk_score_passthrough():
    repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("track_a", 0, 1000, "x", "ru"), 0.7)],
        library_results=[],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
    )
    assert len(res.chunks) == 1
    assert res.chunks[0]["score"] == pytest.approx(0.7)


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


def test_label_letter_with_nothing_is_dropped():
    """No date, no source/tokens → no real address → drop (None), rather
    than a generic "Letter" chip."""
    c = _LibChunk(
        item_id="doc_xyz", item_kind="letter", text="t", lang="en",
        addr_label="", source_id="", tokens="",
    )
    assert _label_for_library_chunk(c) is None


def test_label_dropped_when_verse_metadata_missing():
    """All metadata missing → drop (None), NEVER a generic "verse" chip and
    NEVER the raw `item_id` (issue #660)."""
    c = _LibChunk(
        item_id="verse_abc-uuid", item_kind="verse", text="t", lang="ru",
        addr_label="", source_id="", tokens="",
    )
    assert _label_for_library_chunk(c) is None


def test_label_dropped_when_library_doc_metadata_missing():
    c = _LibChunk(
        item_id="doc_abc-uuid", item_kind="commentary", text="t", lang="ru",
        addr_label="", source_id="", tokens="",
    )
    assert _label_for_library_chunk(c) is None


# ---- _label_for_lecture_chunk + _fmt_timecode -----------------------------


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (0, "0:00"),
        (4_000, "0:04"),
        (64_000, "1:04"),
        (3_600_000, "1:00:00"),
        (3_725_000, "1:02:05"),
        (None, "0:00"),
    ],
)
def test_fmt_timecode(ms, expected):
    assert _fmt_timecode(ms) == expected


def test_lecture_label_is_title_and_timecode():
    c = _LecChunk("track_A", 64_000, 90_000, "raw transcript text", "ru")
    assert _label_for_lecture_chunk(c, "Утренняя прогулка") == "Утренняя прогулка · 1:04"


def test_lecture_label_dropped_when_no_title():
    """No resolved title → drop (None): a bare timecode and the raw
    transcript snippet are both meaningless in the panel."""
    c = _LecChunk("track_A", 64_000, 90_000, "raw transcript text", "ru")
    assert _label_for_lecture_chunk(c, None) is None
    assert _label_for_lecture_chunk(c, "   ") is None


def test_merge_fanout_dedupes_by_internal_key():
    env1 = {"type": "lecture", "ref": 1, "score": 0.6, "_dedup_key": ("lecture", "t", 0, 1000)}
    env2 = {"type": "lecture", "ref": 1, "score": 0.8, "_dedup_key": ("lecture", "t", 0, 1000)}
    a = FanoutResult(chunks=[env1], by_kind={"lecture": [env1]}, max_score=0.6, rounds_executed=1)
    b = FanoutResult(chunks=[env2], by_kind={"lecture": [env2]}, max_score=0.8, rounds_executed=2)
    merged = merge_fanout(a, b)
    assert len(merged.chunks) == 1
    assert merged.chunks[0]["score"] == pytest.approx(0.8)
    assert merged.rounds_executed == 2


# ---- hybrid lexical lane (P2) ---------------------------------------------


class _RerankPrefer:
    """Cross-encoder stub that ranks one target text #1 (simulates the real
    reranker valuing a short verse on its TEXT, not its weak cosine)."""

    def __init__(self, top_text: str) -> None:
        self.top_text = top_text

    async def rerank(self, query, texts, top_k=None):
        scored = [
            (i, 2.0 if t == self.top_text else 1.0 - i * 0.001)
            for i, t in enumerate(texts)
        ]
        return sorted(scored, key=lambda x: x[1], reverse=True)


@pytest.mark.asyncio
async def test_lexical_surfaces_verse_dense_missed():
    # Dense finds NO verse; the lexical lane finds one at a low cosine (0.35).
    # It enters the pool (forced) and the cross-encoder — ranking it on text —
    # promotes it into the kept set. This is the prod "0 verses" fix.
    repo = FakeChunkRepo(
        lecture_results=[_lec(i, 0.60) for i in range(16)],
        library_results=[],
        lexical_results=[_verse(1, 0.35)],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        reranker=_RerankPrefer("verse_1"), rerank_query="q",
    )
    assert len(res.by_kind.get("verse", [])) == 1
    assert repo.lexical_calls > 0
    # max_score stays the true max COSINE of the ranked set (lectures at 0.60),
    # NOT inflated by the forced verse — proves no synthetic score leaked.
    assert res.max_score == pytest.approx(0.60)


@pytest.mark.asyncio
async def test_lexical_inert_without_reranker():
    # Cosine-only path (no reranker): the lexical lane must not run at all.
    repo = FakeChunkRepo(
        lecture_results=[_lec(0, 0.60)],
        library_results=[],
        lexical_results=[_verse(1, 0.35)],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
    )
    assert repo.lexical_calls == 0
    assert "verse" not in res.by_kind


@pytest.mark.asyncio
async def test_lexical_and_dense_dedup_same_chunk():
    # Same verse surfaced by BOTH dense and lexical → one envelope.
    repo = FakeChunkRepo(
        lecture_results=[_lec(i, 0.50) for i in range(3)],
        library_results=[_verse(7, 0.65)],
        lexical_results=[_verse(7, 0.65)],
    )
    res = await fanout_search_with_boost(
        queries=[(0, "q")], embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        reranker=FakeReranker(), rerank_query="q",
    )
    assert len(res.by_kind.get("verse", [])) == 1


@pytest.mark.asyncio
async def test_address_fastpath_fetches_named_verse():
    # "БГ 2.13" in the question → exact verse fetched deterministically even
    # though dense + lexical found nothing.
    verse = _LibChunk("verse_bg213", "verse", "krishna verse", "ru",
                      source_id="BG", tokens="2.13", addr_label="БГ 2.13")
    repo = FakeChunkRepo(
        lecture_results=[_lec(i, 0.55) for i in range(3)],
        library_results=[],
        addr_results={"БГ 2.13": [verse]},
    )
    res = await fanout_search_with_boost(
        queries=[(0, "что Прабхупада говорит в БГ 2.13")],
        embedder=FakeEmbedder(), chunk_repo=repo,
        catalog_repo=FakeCatalogRepo(), alias_map=FakeAliasMap(),
        reranker=FakeReranker(), rerank_query="что Прабхупада говорит в БГ 2.13",
    )
    assert len(res.by_kind.get("verse", [])) == 1


def test_parse_addresses():
    assert _parse_addresses("что в БГ 2.13?") == ["БГ 2.13"]
    assert _parse_addresses("ШБ 1.1.1 и BG 2.13") == ["ШБ 1.1.1", "BG 2.13"]
    assert _parse_addresses("БГ 1.2.28,1.2.29") == ["БГ 1.2.28,1.2.29"]
    assert _parse_addresses("что такое душа") == []


# ---- dedup_notes_by_key (final-note-set de-duplication) -------------------


def _note(dedup_key, *, ref, score=0.5, type_="media"):
    """Minimal envelope shape: dedup_notes_by_key only reads `_dedup_key`."""
    return {"type": type_, "ref": ref, "score": score, "_dedup_key": dedup_key}


def test_dedup_notes_by_key_collapses_duplicate_media():
    # Same media clip surfaced through two paths/rounds → two envelopes,
    # each with its own minted alias (ref 5 and ref 60). The dedup must keep
    # ONLY the first occurrence so the synthesizer sees one citable note.
    key = ("media", "fsp-1-en-010-spk7", 0)
    notes = [
        _note(key, ref=5),
        _note(("verse", "BG", 0), ref=7, type_="verse"),
        _note(key, ref=60),  # duplicate of the media clip — second alias
    ]
    from lectorium_chat.research.corpus_fanout import dedup_notes_by_key

    out = dedup_notes_by_key(notes)

    assert len(out) == 2
    media = [n for n in out if n["type"] == "media"]
    assert len(media) == 1
    assert media[0]["ref"] == 5  # first occurrence kept


def test_dedup_notes_by_key_keeps_distinct_sources():
    # Different kinds / ids / segments must all survive untouched.
    from lectorium_chat.research.corpus_fanout import dedup_notes_by_key

    notes = [
        _note(("media", "m1", 0), ref=1),
        _note(("media", "m1", 1), ref=2),          # same item, diff segment
        _note(("media", "m2", 0), ref=3),
        _note(("verse", "BG", 0), ref=4, type_="verse"),
        _note(("commentary", "c1", 2), ref=5, type_="commentary"),
        _note(("lecture", "track_X", 1000, 2000), ref=6, type_="lecture"),
    ]
    out = dedup_notes_by_key(notes)
    assert len(out) == 6


def test_dedup_notes_by_key_passes_through_keyless_notes():
    # Notes without a _dedup_key (history echoes) are left untouched.
    from lectorium_chat.research.corpus_fanout import dedup_notes_by_key

    notes = [
        {"type": "media", "ref": 1},          # no _dedup_key
        _note(("media", "m1", 0), ref=2),
        _note(("media", "m1", 0), ref=3),     # duplicate, dropped
    ]
    out = dedup_notes_by_key(notes)
    assert len(out) == 2
    assert out[0] == {"type": "media", "ref": 1}


@pytest.mark.asyncio
async def test_the_private_lane_ignores_the_answer_language() -> None:
    """A personal library is tens of recordings, often in another language than the
    question. Filtering it by the answer language is how production answered
    «не найдено» for three English lectures by exactly the asked-for teacher, while
    the corpus lane happily served someone else.

    The public lane keeps its language filter: half a million chunks, and its
    per-(kind,lang) partial indexes are the reason it is fast.
    """
    seen: list[tuple[str, str | None]] = []

    class _Repo(FakeChunkRepo):
        async def search_by_embedding(
            self, q_vec, *, eligible_track_ids=None, lang=None, top_k=8,
            kind="track_transcript", **_kw,
        ):
            seen.append((kind, lang))
            return []

        async def search_library_by_embedding(self, q_vec, *, kinds, lang=None, **kw):
            return []

    await fanout_search_with_boost(
        queries=[(0, "q")],
        embedder=FakeEmbedder(),
        chunk_repo=_Repo([], []),
        catalog_repo=FakeCatalogRepo({}),
        alias_map=FakeAliasMap(),
        lang="ru",
        owned_track_ids=["mine-en"],
    )

    assert ("user_track", None) in seen, f"private lane must not filter by lang: {seen}"
    assert ("track_transcript", "ru") in seen, "public lane keeps its language"
