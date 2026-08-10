"""Unit tests for research.pipeline.run_research — orchestrator.

Heavy fake harness: every collaborator (embedder, chunk_repo, catalog_repo,
llm, pool, alias_map) is a thin in-memory stub. Real Postgres + LLM behaviour
is covered by integration tests.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest
from pathlib import Path

from lectorium_chat.research.models import (
    AttributionMatch,
    AttributionRef,  # noqa: F401
    MemoryResolution,
    QueryPlan,
    ResearchResult,
    SubQuery,
    TopicExtractionResult,
)
from lectorium_chat.application.author_scope import AuthorScope
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import LECTURE_AUTHORS, Attribute
from lectorium_chat.research.pipeline import (
    _attach_memory,
    _resolve_memory,
    run_research,
)


def _plan(*texts: str) -> QueryPlan:
    """Helper — build a QueryPlan from plain text strings. Each text becomes
    its own general-type sub_query (matches the legacy ExpansionResult
    fixture pattern). Empty `texts` returns an empty plan."""
    return QueryPlan(sub_queries=[
        SubQuery(id=i, type="general", text=t) for i, t in enumerate(texts)
    ])


# ---- fakes ----------------------------------------------------------------


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


@dataclass
class FakeEmbedder:
    embed_query_returns: list[float] | None = None
    embed_docs_returns: list[list[float]] | None = None
    embed_query_raises: bool = False
    queries_called: int = 0
    docs_called: int = 0

    async def embed_query(self, text: str) -> list[float]:
        self.queries_called += 1
        if self.embed_query_raises:
            raise RuntimeError("embed failed")
        return self.embed_query_returns or [0.0] * 1536

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self.docs_called += 1
        if self.embed_docs_returns is not None:
            return self.embed_docs_returns
        return [[0.0] * 1536 for _ in texts]

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return await self.embed_documents(texts)


class FakeCatalogRepo:
    def __init__(
        self,
        titles: dict[str, str] | None = None,
        author_names: dict[str, str] | None = None,
    ) -> None:
        self._titles = titles or {}
        self._author_names = author_names or {}

    async def filter_track_ids(self, **_kwargs) -> list[str] | None:
        return None

    async def get_titles(self, track_ids, *, lang=None) -> dict[str, str]:
        return {t: self._titles[t] for t in track_ids if t in self._titles}

    async def get_author_names(self, author_ids, *, lang) -> dict[str, str]:
        return {a: self._author_names[a] for a in author_ids if a in self._author_names}


@dataclass
class FakeChunkRepo:
    lecture_results: list[_Scored] = field(default_factory=list)
    library_results: list[_Scored] = field(default_factory=list)
    by_target: dict[tuple[str, str], list[Any]] = field(default_factory=dict)
    by_verse: dict[tuple[str, str], list[Any]] = field(default_factory=dict)
    fanout_calls: int = 0

    async def search_by_embedding(self, q_vec, *, eligible_track_ids=None, lang=None, top_k=8):
        self.fanout_calls += 1
        return self.lecture_results[:top_k]

    async def search_library_by_embedding(self, q_vec, *, kinds, lang=None, **_kwargs):
        return [s for s in self.library_results if s.chunk.item_kind in kinds][:_kwargs.get("top_k", 8)]

    async def get_chunks_by_target(self, *, ref_kind: str, target_id: str, lang: str | None = None):
        return self.by_target.get((ref_kind, target_id), [])

    async def get_chunks_by_verse(self, *, source_id: str, tokens: str, kinds, lang: str | None = None):
        return self.by_verse.get((source_id, tokens), [])


class FakeAliasMap:
    def __init__(self) -> None:
        self._lec = 0
        self._verse = 0
        self._lec_map: dict[tuple, int] = {}
        self._verse_map: dict[tuple, int] = {}
        # Background caption generator writes here. Real `TurnAliasMap`
        # exposes the same attribute — pipeline expects it.
        self.captions: dict[int, str] = {}
        # `lecture_to_envelope` stashes the exact chunk text here at mint.
        self.chunk_texts: dict[int, str] = {}
        # Records the author_name passed to each minted commentary alias, so
        # tests can assert the pinned path resolved it (not None).
        self.commentary_authors: dict[int, str | None] = {}

    def alias_chunk(self, track_id, start_ms, end_ms, lang=None):
        key = (track_id, start_ms, end_ms)
        if key in self._lec_map:
            return self._lec_map[key]
        self._lec += 1
        self._lec_map[key] = self._lec
        return self._lec

    def alias_verse(self, source_id, tokens, addr_label):
        key = (source_id, tokens)
        if key in self._verse_map:
            return self._verse_map[key]
        self._verse += 1
        self._verse_map[key] = self._verse
        return self._verse

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences, kind="commentary"):
        self._verse += 1
        self.commentary_authors[self._verse] = author_name
        return self._verse


@dataclass
class FakeLLM:
    """Returns scripted structured outputs by schema name. Each call records."""

    by_schema: dict[str, Any] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    raise_on_schema: str | None = None
    slow_on_schema: str | None = None

    async def structured_output(self, messages, schema, *, model=None, **_extra):
        name = schema.__name__
        self.calls.append(name)
        if self.raise_on_schema == name:
            raise RuntimeError("LLM down")
        if self.slow_on_schema == name:
            await asyncio.sleep(99)
        if name in self.by_schema:
            return self.by_schema[name]
        return schema()


class FakePool:
    """asyncpg-shaped fake. Stores attribution rows keyed by (kind, lang), plus
    optional curated variant phrasings keyed by attribution_id (what the
    border-judge gate reranks / LLM-confirms against)."""

    def __init__(
        self,
        rows: dict[tuple, list[dict]] | None = None,
        variant_texts: dict[str, list[str]] | None = None,
    ) -> None:
        self.rows = rows or {}
        self.variant_texts = variant_texts or {}

    def acquire(self):
        return _Acq(self.rows, self.variant_texts)


class _Acq:
    def __init__(self, rows: dict[tuple, list[dict]], variant_texts: dict[str, list[str]]):
        self.rows = rows
        self.conn = _FakeConn(rows, variant_texts)

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return None


class _FakeConn:
    def __init__(self, rows: dict[tuple, list[dict]], variant_texts: dict[str, list[str]]):
        self.rows = rows
        self.variant_texts = variant_texts

    async def fetch(self, sql, *args):
        # Border-judge gate: _fetch_variant_texts issues two shapes of this query
        # (with/without a language filter → 3 or 2 positional args). Keyed on the
        # attribution_id ($1) in both, so match on the projection, not arg count.
        if "DISTINCT text" in sql:
            aid = args[0]
            return [{"text": t} for t in self.variant_texts.get(aid, [])]
        if "WHERE e.language" in sql:
            lang, _embed_model, kind = args[1], args[2], args[3]
            return [dict(r) for r in self.rows.get((lang, kind), [])]
        _embed_model, kind = args[1], args[2]
        return [dict(r) for r in self.rows.get((None, kind), [])]


def _row(aid: str, score: float, refs: list[dict]) -> dict:
    import json
    return {"id": aid, "refs_json": json.dumps(refs), "score": score}


def _common_kwargs(*, llm, pool, chunk_repo=None, embedder=None, catalog_repo=None) -> dict:
    return {
        "chunk_repo": chunk_repo or FakeChunkRepo(),
        "catalog_repo": catalog_repo or FakeCatalogRepo(),
        "embedder": embedder or FakeEmbedder(),
        "alias_map": FakeAliasMap(),
        "pool": pool,
        "llm": llm,
        "embed_model": "openai/text-embedding-3-small",
        # Default to the legacy 1536 dim (text-embedding-3-small);
        # router will resolve `attribution_emb_d1536` for the lookup
        # SQL — the FakePool below ignores the table name in any case.
        "embed_dim": 1536,
    }


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_short_path_question_match():
    """Question-attribution found → authoritative refs populated, no topic
    lookup, no extract_topics LLM call."""
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_q1", 0.92, [
                {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        by_target={
            ("verse", "verse_BG_2_13"): [
                _LibChunk("verse_BG_2_13", "verse", "atma is eternal", "ru",
                          source_id="source_BG", tokens="2.13", addr_label="БГ 2.13"),
            ],
        },
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("природа души", "atma"),
    })

    result = await run_research(
        question="что такое душа", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    assert result.matched_question_ids == ["attribution_q1"]
    assert result.matched_topic_ids == []
    assert len(result.authoritative_refs) == 1
    # Authoritative envelopes carry canonical_score >= 0.85 so synth doesn't refuse.
    assert result.authoritative_refs[0]["score"] == pytest.approx(0.92)
    # Stage 2.8.b makes extract_topics speculative — it fires in parallel
    # with plan_queries and gets cancelled in SHORT path. With FakeLLM
    # being instant, the call lands before cancel; that's a known
    # trade-off (we'd rather burn one Flash-Lite call than serialise
    # the LONG path). What matters here is that topics didn't influence
    # the result, which `matched_topic_ids == []` already asserts.


@pytest.mark.asyncio
async def test_short_path_multi_match_unions_refs():
    """Two question-matches with partially overlapping refs → deduped union."""
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_a", 0.95, [
                {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
                {"ref_kind": "verse", "target_id": "verse_BG_2_20"},
            ]),
            _row("attribution_b", 0.93, [
                {"ref_kind": "verse", "target_id": "verse_BG_2_13"},   # dup
                {"ref_kind": "verse", "target_id": "verse_BG_2_22"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(by_target={
        ("verse", "verse_BG_2_13"): [_LibChunk("verse_BG_2_13", "verse", "13", "ru", source_id="src", tokens="2.13")],
        ("verse", "verse_BG_2_20"): [_LibChunk("verse_BG_2_20", "verse", "20", "ru", source_id="src", tokens="2.20")],
        ("verse", "verse_BG_2_22"): [_LibChunk("verse_BG_2_22", "verse", "22", "ru", source_id="src", tokens="2.22")],
    })
    llm = FakeLLM(by_schema={"QueryPlan": _plan("q")})

    result = await run_research(
        question="природа души", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    assert set(result.matched_question_ids) == {"attribution_a", "attribution_b"}
    # 3 unique verses (13, 20, 22) — dedupe killed the duplicate 2.13.
    target_ids = sorted(env["meta"]["tokens"] for env in result.authoritative_refs)
    assert target_ids == ["2.13", "2.20", "2.22"]


@pytest.mark.asyncio
async def test_short_path_document_cites_full_body_not_chunks(monkeypatch):
    """A pinned document ref cites ONE envelope built from the canonical
    library.db body (clean, no chunk-overlap), not N overlapping chunks."""
    import lectorium_chat.research.pipeline as pl

    async def fake_body(library_db, item_id, lang="ru"):
        assert item_id == "doc_charter"
        return "Цель один.\n\nЦель два.\n\nЦель три."

    monkeypatch.setattr(pl, "fetch_document_body", fake_body)

    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_doc", 0.95, [
                {"ref_kind": "document", "target_id": "doc_charter"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(by_target={
        # Three overlapping chunks in Postgres — the OLD path would emit 3
        # envelopes with repeated text; the new path collapses to the body.
        ("document", "doc_charter"): [
            _LibChunk("doc_charter", "prose_chapter", "Цель один. Цель два.", "ru",
                      source_id="src", tokens="2.2", addr_label="Цели ISKCON", segment_index=0),
            _LibChunk("doc_charter", "prose_chapter", "Цель два. Цель три.", "ru",
                      source_id="src", tokens="2.2", addr_label="Цели ISKCON", segment_index=1),
        ],
    })
    llm = FakeLLM(by_schema={"QueryPlan": _plan("цели")})

    result = await run_research(
        question="цели ИСККОН", lang="ru", router_args={},
        library_db=Path("/fake/library.db"),
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    # ONE authoritative envelope (collapsed), carrying the full clean body.
    assert len(result.authoritative_refs) == 1
    assert result.authoritative_refs[0]["text"] == "Цель один.\n\nЦель два.\n\nЦель три."


@pytest.mark.asyncio
async def test_short_path_drops_supplementary_chunks_of_pinned_document():
    """When a pinned ref pulls a document IN FULL, supplementary fanout hits
    of that SAME document are dropped (no piecemeal re-citation), while
    fanout hits of OTHER documents survive."""
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_doc", 0.95, [
                {"ref_kind": "document", "target_id": "doc_charter"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        by_target={
            # Authoritative: the whole charter (one segment here for brevity).
            ("document", "doc_charter"): [
                _LibChunk("doc_charter", "prose_chapter", "the seven aims …", "ru",
                          source_id="src", tokens="2.2", addr_label="Цели ISKCON"),
            ],
        },
        library_results=[
            # Supplementary fanout surfaces a FRAGMENT of the same charter …
            _Scored(_LibChunk("doc_charter", "prose_chapter", "aim two fragment", "ru",
                              source_id="src", tokens="2.2", segment_index=3), 0.7),
            # … and a chunk of a DIFFERENT document.
            _Scored(_LibChunk("doc_other", "commentary", "unrelated purport", "ru",
                              source_id="src", tokens="9.9", addr_label="ШБ 9.9"), 0.66),
        ],
    )
    llm = FakeLLM(by_schema={"QueryPlan": _plan("цели общества", "цели")})

    result = await run_research(
        question="цели ИСККОН", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    assert result.matched_question_ids == ["attribution_doc"]
    # Authoritative carries the full charter.
    assert len(result.authoritative_refs) == 1
    # Supplementary: the same-document fragment is gone; the other doc stays.
    texts = {e["text"] for e in result.research_chunks}
    assert "aim two fragment" not in texts, "same-document fanout fragment must be dropped"
    assert "unrelated purport" in texts, "other-document fanout chunk must survive"


@pytest.mark.asyncio
async def test_long_path_no_question_match():
    """No question match → extract_topics → topic lookup → fanout."""
    pool = FakePool({
        # No question matches.
        ("ru", "pinned"): [],
        (None, "pinned"): [],
        # Topic match returns refs to verse_boost.
        ("ru", "boost"): [
            _row("attribution_t1", 0.75, [
                {"ref_kind": "verse", "target_id": "verse_boost"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[],
        library_results=[
            _Scored(_LibChunk("verse_boost", "verse", "BOOSTED", "ru",
                              source_id="src", tokens="2.20", addr_label="x"), 0.55),
            _Scored(_LibChunk("verse_other", "verse", "OTHER", "ru",
                              source_id="src", tokens="2.21", addr_label="y"), 0.65),
        ],
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q1", "q2"),
        "TopicExtractionResult": TopicExtractionResult(topics=["вечность души"]),
    })

    result = await run_research(
        question="что Прабхупада говорил о вечности атмана", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    assert result.authoritative_refs == []
    assert result.matched_question_ids == []
    assert "attribution_t1" in result.matched_topic_ids
    # LONG path: topic-attribution matched, fanout verses reach research_chunks.
    texts = {e["text"] for e in result.research_chunks}
    assert {"BOOSTED", "OTHER"} <= texts


@pytest.mark.asyncio
async def test_long_path_no_topics_extracted_no_boost():
    """LLM returns 0 topics → no topic matches → plain fanout."""
    pool = FakePool({("ru", "pinned"): []})
    chunk_repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("track_a", 0, 1000, "x", "ru"), 0.6)],
        library_results=[],
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),  # empty
    })
    result = await run_research(
        question="q", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    assert result.matched_topic_ids == []
    # Fanout still runs (the lecture chunk should be there).
    assert len(result.research_chunks) == 1


@pytest.mark.asyncio
async def test_cold_start_empty_attributions_pure_fanout():
    """Both lookups return [] → no attribution matches → plain fanout. No crash."""
    pool = FakePool({})  # no rows for any (lang, kind)
    chunk_repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("t", 0, 1000, "lec", "ru"), 0.7)],
        library_results=[],
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=["x"]),
    })
    result = await run_research(
        question="что про карму", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    assert result.authoritative_refs == []
    assert result.matched_question_ids == []
    assert result.matched_topic_ids == []
    assert len(result.research_chunks) == 1  # lecture chunk via fanout


@pytest.mark.asyncio
async def test_expand_failure_falls_back_to_question_only():
    """plan_queries raises → degraded QueryPlan with a single sub_query
    containing the raw question."""
    pool = FakePool({("ru", "pinned"): []})
    chunk_repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("t", 0, 1000, "x", "ru"), 0.7)],
        library_results=[],
    )
    llm = FakeLLM(
        by_schema={"TopicExtractionResult": TopicExtractionResult(topics=[])},
        raise_on_schema="QueryPlan",
    )
    # expand_query swallows its own errors so the outer await never raises;
    # we just verify the pipeline completes with one fanout call.
    result = await run_research(
        question="вопрос", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    assert len(result.research_chunks) == 1


@pytest.mark.asyncio
async def test_embed_failure_falls_through_to_fanout():
    """User-query embed fails → no attribution lookup possible → straight fanout."""
    pool = FakePool({})
    chunk_repo = FakeChunkRepo(
        lecture_results=[_Scored(_LecChunk("t", 0, 1000, "x", "ru"), 0.7)],
        library_results=[],
    )
    embedder = FakeEmbedder(embed_query_raises=True)
    llm = FakeLLM(by_schema={"QueryPlan": _plan("q")})
    result = await run_research(
        question="вопрос", lang="ru", router_args={},
        chunk_repo=chunk_repo, catalog_repo=FakeCatalogRepo(),
        embedder=embedder, alias_map=FakeAliasMap(),
        pool=pool, llm=llm, embed_model="m", embed_dim=1536,
    )
    assert result.authoritative_refs == []
    assert len(result.research_chunks) == 1


@pytest.mark.asyncio
async def test_router_args_propagated_to_fanout(monkeypatch):
    """Filter args from router_args (author_id, tag_ids, dates) reach fanout."""
    pool = FakePool({("ru", "pinned"): []})
    captured: list[dict] = []

    class _CatalogRepoCapture:
        async def filter_track_ids(self, **kwargs):
            captured.append(kwargs)
            return None

    chunk_repo = FakeChunkRepo(lecture_results=[], library_results=[])
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),
    })
    await run_research(
        question="x", lang="ru",
        router_args={"author_id": "author_p", "tag_ids": ["t1"], "doc_date_from": "1972-01-01"},
        chunk_repo=chunk_repo, catalog_repo=_CatalogRepoCapture(),
        embedder=FakeEmbedder(), alias_map=FakeAliasMap(),
        pool=pool, llm=llm, embed_model="m", embed_dim=1536,
    )
    assert captured  # filter_track_ids was called
    assert captured[0]["author_ids"] == ["author_p"]
    assert captured[0]["tag_ids"] == ["t1"]
    assert captured[0]["date_from"] == "1972-01-01"


@pytest.mark.asyncio
async def test_authoritative_carries_canonical_score():
    """Authoritative envelopes MUST carry score = top_match.score so the
    synthesizer doesn't refuse them as junk (score < 0.45)."""
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_q", 0.91, [{"ref_kind": "verse", "target_id": "verse_x"}]),
        ],
    })
    chunk_repo = FakeChunkRepo(by_target={
        ("verse", "verse_x"): [_LibChunk("verse_x", "verse", "t", "ru", source_id="src", tokens="2.13")],
    })
    llm = FakeLLM(by_schema={"QueryPlan": _plan()})
    result = await run_research(
        question="q", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    assert result.authoritative_refs[0]["score"] == pytest.approx(0.91)


@pytest.mark.asyncio
async def test_on_event_emits_research_questions_short_path():
    """SHORT path: on_event receives one research_question per non-echo
    sub-query, and a research_source per attribution ref consulted."""
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_q", 0.92, [
                {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
                {"ref_kind": "document", "target_id": "doc_letter_42"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(by_target={
        ("verse", "verse_BG_2_13"): [
            _LibChunk("verse_BG_2_13", "verse", "atma", "ru",
                      source_id="src", tokens="2.13", addr_label="БГ 2.13"),
        ],
        ("document", "doc_letter_42"): [
            _LibChunk("doc_letter_42", "letter", "...", "ru",
                      source_id="src", tokens="", addr_label="Letter 42"),
        ],
    })
    # Expansion echoes the original question once and adds two real angles —
    # only the two should be emitted as research_question (echo filtered).
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("что такое душа", "природа души", "atma"),
    })

    events: list[tuple[str, dict]] = []

    await run_research(
        question="что такое душа", lang="ru", router_args={},
        on_event=lambda t, d: events.append((t, d)),
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    questions = [d["question"] for t, d in events if t == "research_question"]
    sources = [d for t, d in events if t == "research_source"]

    assert questions == ["природа души", "atma"], (
        "echo of the original question must be filtered out"
    )
    # Two attribution refs → two research_source events (one per consulted
    # chunk, emitted after each DB round-trip surfaces the real addr_label).
    source_ids = sorted(s["id"] for s in sources if s["id"].startswith(("verse:", "library:")))
    assert "verse:verse_BG_2_13" in source_ids
    assert "library:doc_letter_42" in source_ids
    # Wire kind discriminator is correct.
    by_id = {s["id"]: s for s in sources}
    assert by_id["verse:verse_BG_2_13"]["kind"] == "verse"
    assert by_id["library:doc_letter_42"]["kind"] == "library_doc"
    # Label is the chunk's real (normalized) addr_label — no generic
    # "verse" / "library document" placeholder, and never the raw
    # target_id (issue #660).
    assert by_id["verse:verse_BG_2_13"]["label"] == "БГ 2.13"
    assert by_id["library:doc_letter_42"]["label"] == "Letter 42"


@pytest.mark.asyncio
async def test_on_event_emits_research_sources_from_fanout():
    """LONG path: corpus_fanout emits research_source per inspected raw
    chunk (lecture / verse / library), keyed for client-side dedup."""
    pool = FakePool({
        ("ru", "pinned"): [],
        (None, "pinned"): [],
        ("ru", "boost"): [],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_A", 60_000, 90_000, "first words of the fragment", "ru"), 0.78),
        ],
        library_results=[
            _Scored(_LibChunk("verse_X", "verse", "atma", "ru",
                              source_id="src", tokens="2.20", addr_label="BG 2.20"), 0.71),
            _Scored(_LibChunk("comm_Y", "commentary", "purport", "ru",
                              source_id="src", tokens="2.20", addr_label="purport of BG 2.20",
                              segment_index=0), 0.66),
        ],
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("вечность"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),
    })

    events: list[tuple[str, dict]] = []

    await run_research(
        question="природа души", lang="ru", router_args={},
        on_event=lambda t, d: events.append((t, d)),
        **_common_kwargs(
            llm=llm, pool=pool, chunk_repo=chunk_repo,
            catalog_repo=FakeCatalogRepo(titles={"track_A": "Утренняя прогулка"}),
        ),
    )

    sources = [d for t, d in events if t == "research_source"]
    by_id = {s["id"]: s for s in sources}

    # Lecture chunk → kind="lecture_chunk", id includes start_ms.
    assert "lecture:track_A:60000" in by_id
    assert by_id["lecture:track_A:60000"]["kind"] == "lecture_chunk"
    # Label is the resolved lecture title + timecode, not the raw transcript
    # snippet nor the opaque track_id.
    assert by_id["lecture:track_A:60000"]["label"] == "Утренняя прогулка · 1:00"

    # Verse → kind="verse", id namespaced.
    assert "verse:verse_X" in by_id
    assert by_id["verse:verse_X"]["kind"] == "verse"
    assert by_id["verse:verse_X"]["label"] == "BG 2.20"

    # Commentary → kind="library_doc" (panel collapses non-verse library
    # kinds into one bucket; addr_label is the human-readable string).
    # The id namespace is `library:<item_id>`, matching the
    # attribution-refs path, so the client's dedup-by-id collapses a
    # doc discovered through both code paths.
    assert "library:comm_Y" in by_id
    assert by_id["library:comm_Y"]["kind"] == "library_doc"


@pytest.mark.asyncio
async def test_on_event_no_callback_is_safe():
    """Pipeline must run identically when on_event is omitted — the
    research worker passes None for the legacy fallback path."""
    pool = FakePool({("ru", "pinned"): []})
    chunk_repo = FakeChunkRepo(lecture_results=[], library_results=[])
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),
    })
    # No on_event kwarg — just confirm it doesn't raise.
    result = await run_research(
        question="x", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    assert result is not None


@pytest.mark.asyncio
async def test_on_event_callback_exception_does_not_break_research():
    """A misbehaving on_event must not unwind the research loop — log
    and move on, since this is pure UI observability."""
    pool = FakePool({("ru", "pinned"): []})
    chunk_repo = FakeChunkRepo(lecture_results=[], library_results=[])
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("вечность"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),
    })

    def boom(_t: str, _d: dict) -> None:
        raise RuntimeError("client died")

    result = await run_research(
        question="x", lang="ru", router_args={}, on_event=boom,
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    # Research completes despite the callback raising.
    assert result is not None


# Commentary pre-attachment in run_research was removed when lazy
# attach moved into `synthesis_planner_node`. The equivalent behaviour
# (commentaries fetched + reranked per-thesis) is covered by
# `tests/research/test_rerank_attach.py`.


# ---- _balanced_cut (final-cut membership guarantee) -----------------------

from lectorium_chat.research.pipeline import _balanced_cut


def _env(t: str, score: float) -> dict:
    return {"type": t, "score": score}


def test_balanced_cut_backfills_verse_and_library_from_tail():
    # 8 lectures fill the cut; a verse and a commentary sit just past it,
    # both above RERANK_RESERVE_FLOOR → both must be pulled back in.
    envs = [_env("lecture", 0.7) for _ in range(8)]
    envs += [_env("verse", 0.55), _env("commentary", 0.5)]
    out = _balanced_cut(envs, 8, min_verses=1, min_library=1)
    kinds = [e["type"] for e in out]
    assert kinds.count("verse") == 1
    assert kinds.count("commentary") == 1
    assert kinds.count("lecture") == 8  # cut grows, lectures untouched


def test_balanced_cut_skips_low_score_tail():
    # Tail verse below the reserve floor (0.30 < 0.40) is NOT back-filled.
    envs = [_env("lecture", 0.7) for _ in range(8)] + [_env("verse", 0.30)]
    out = _balanced_cut(envs, 8, min_verses=1, min_library=1)
    assert all(e["type"] == "lecture" for e in out)


def test_balanced_cut_noop_when_already_present_or_short():
    # Verse already inside the top-n → no growth.
    envs = [_env("verse", 0.8)] + [_env("lecture", 0.7) for _ in range(7)] + [_env("verse", 0.5)]
    out = _balanced_cut(envs, 8, min_verses=1, min_library=0)
    assert len(out) == 8
    # Shorter than n → returned as-is.
    short = [_env("lecture", 0.7), _env("verse", 0.6)]
    assert _balanced_cut(short, 8) == short


@pytest.mark.asyncio
async def test_short_path_commentary_ref_resolves_author_name():
    """A pinned attribution referencing a commentary resolves the author name
    so its blockquote carries '— А. Ч. …', not just the address. Regression:
    the authoritative path skipped author resolution (fanout/commentary_expansion
    did it), so a pinned purport rendered with no author. Chunk path (library_db
    defaults to None) → one envelope per commentary chunk."""
    AUTHOR = "author_jcC2O92Hi1kT"
    pool = FakePool({
        ("ru", "pinned"): [
            _row("attribution_comm", 0.95, [
                {"ref_kind": "document", "target_id": "doc_purport"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(by_target={
        ("document", "doc_purport"): [
            _LibChunk("doc_purport", "commentary", "Душа атомарна по природе.", "ru",
                      source_id="src", tokens="2.17", addr_label="БГ 2.17",
                      author_id=AUTHOR),
        ],
    })
    catalog = FakeCatalogRepo(
        author_names={AUTHOR: "А. Ч. Бхактиведанта Свами Прабхупада"},
    )
    alias = FakeAliasMap()
    llm = FakeLLM(by_schema={"QueryPlan": _plan("душа")})

    kwargs = _common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo, catalog_repo=catalog)
    kwargs["alias_map"] = alias
    result = await run_research(
        question="что такое душа", lang="ru", router_args={}, **kwargs,
    )

    assert result.matched_question_ids == ["attribution_comm"]
    assert len(result.authoritative_refs) == 1
    # The commentary alias was minted WITH the resolved author name.
    assert "А. Ч. Бхактиведанта Свами Прабхупада" in alias.commentary_authors.values()


# ---- provider-unavailable degradation (corpus fanout) ---------------------

import openai  # noqa: E402

from lectorium_chat.domain.ports.llm_provider import (  # noqa: E402
    ProviderUnavailable,
    provider_unavailable,
)


@dataclass
class _FanoutBoomEmbedder:
    """embed_query succeeds (so attribution lookup proceeds), but
    embed_documents raises a PROVIDER-UNAVAILABLE error — the failure mode of
    OpenRouter being out of credits / down DURING the fanout embed call.

    Raises what the real adapter raises. `OpenAIEmbedder` labels a spent
    availability failure as `ProviderUnavailable` (keeping the vendor error as
    __cause__), so a fake that emitted the raw vendor exception would be
    modelling a contract the adapter no longer has — and would quietly stop
    exercising the propagation this test exists for."""

    docs_called: int = 0

    async def embed_query(self, text: str) -> list[float]:
        return [0.0] * 1536

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self.docs_called += 1
        vendor = openai.APIConnectionError(request=None)  # type: ignore[arg-type]
        raise ProviderUnavailable(str(vendor)) from vendor

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        # Fanout sub-queries route through the query path; raise the same
        # provider-unavailable error there too.
        return await self.embed_documents(texts)


@pytest.mark.asyncio
async def test_fanout_provider_unavailable_propagates_not_partial():
    """An embedder that raises a provider-availability error during corpus
    fanout must PROPAGATE (so chat_turn surfaces a calm `chat_unavailable`),
    NOT be swallowed into an empty/partial outline. `_safe` re-raises a
    provider-unavailable error rather than degrading it to its default."""
    pool = FakePool({("ru", "pinned"): []})  # no question match → LONG path → fanout
    chunk_repo = FakeChunkRepo(lecture_results=[], library_results=[])
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),  # straight to fanout
    })
    embedder = _FanoutBoomEmbedder()

    with pytest.raises(Exception) as ei:
        await run_research(
            question="вопрос", lang="ru", router_args={},
            chunk_repo=chunk_repo, catalog_repo=FakeCatalogRepo(),
            embedder=embedder, alias_map=FakeAliasMap(),
            pool=pool, llm=llm, embed_model="m", embed_dim=1536,
        )
    # The error chat_turn will classify is a provider-availability failure.
    assert provider_unavailable(ei.value) is True
    assert embedder.docs_called >= 1


@pytest.mark.asyncio
async def test_fanout_non_provider_error_still_degrades():
    """A NON-provider error during fanout embed still degrades gracefully to
    an empty result (regression guard for the `_safe` carve-out — only
    provider-unavailable errors propagate, everything else is swallowed)."""

    @dataclass
    class _PlainBoomEmbedder:
        async def embed_query(self, text: str) -> list[float]:
            return [0.0] * 1536

        async def embed_documents(self, texts: list[str]) -> list[list[float]]:
            raise RuntimeError("a bug in our own code, not the provider")

        async def embed_queries(self, texts: list[str]) -> list[list[float]]:
            return await self.embed_documents(texts)

    pool = FakePool({("ru", "pinned"): []})
    chunk_repo = FakeChunkRepo(lecture_results=[], library_results=[])
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=[]),
    })
    result = await run_research(
        question="вопрос", lang="ru", router_args={},
        chunk_repo=chunk_repo, catalog_repo=FakeCatalogRepo(),
        embedder=_PlainBoomEmbedder(), alias_map=FakeAliasMap(),
        pool=pool, llm=llm, embed_model="m", embed_dim=1536,
    )
    # Degraded, not raised: empty research with no crash.
    assert result.research_chunks == []
    assert result.authoritative_refs == []


# ---- #4: boost topic-ref rerank gate --------------------------------------


@dataclass
class _FakeReranker:
    """Returns scripted (index, score) pairs by document text. Any text not in
    the map is omitted (mimics the reranker's own top_k cut)."""

    score_by_text: dict[str, float] = field(default_factory=dict)
    name: str = "fake-reranker"

    async def rerank(self, query, documents, *, top_k=None):
        out = []
        for i, d in enumerate(documents):
            if d in self.score_by_text:
                out.append((i, self.score_by_text[d]))
        return out


@pytest.mark.asyncio
async def test_boost_topic_refs_gated_by_reranker():
    """A fetched boost topic-ref that the reranker scores BELOW the accept
    threshold is dropped; an on-topic one is kept. The normal fanout path is
    untouched."""
    pool = FakePool({
        ("ru", "pinned"): [],
        (None, "pinned"): [],
        ("ru", "boost"): [
            _row("attribution_t1", 0.75, [
                {"ref_kind": "verse", "target_id": "verse_on_topic"},
                {"ref_kind": "verse", "target_id": "verse_off_topic"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[],
        library_results=[],
        by_target={
            ("verse", "verse_on_topic"): [
                _LibChunk("verse_on_topic", "verse", "ON TOPIC", "ru",
                          source_id="src", tokens="2.1", addr_label="x"),
            ],
            ("verse", "verse_off_topic"): [
                _LibChunk("verse_off_topic", "verse", "OFF TOPIC", "ru",
                          source_id="src", tokens="2.2", addr_label="y"),
            ],
        },
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=["t"]),
    })
    reranker = _FakeReranker(score_by_text={"ON TOPIC": 0.9, "OFF TOPIC": 0.1})

    kwargs = _common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo)
    result = await run_research(
        question="вопрос", lang="ru", router_args={},
        reranker=reranker, **kwargs,
    )
    texts = {e["text"] for e in result.research_chunks}
    assert "ON TOPIC" in texts
    assert "OFF TOPIC" not in texts


@pytest.mark.asyncio
async def test_boost_topic_refs_ungated_without_reranker():
    """No reranker wired → boost refs pass through ungated (prior behaviour),
    both on- and off-topic refs surface."""
    pool = FakePool({
        ("ru", "pinned"): [],
        (None, "pinned"): [],
        ("ru", "boost"): [
            _row("attribution_t1", 0.75, [
                {"ref_kind": "verse", "target_id": "verse_a"},
                {"ref_kind": "verse", "target_id": "verse_b"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[], library_results=[],
        by_target={
            ("verse", "verse_a"): [
                _LibChunk("verse_a", "verse", "A", "ru", source_id="s", tokens="1.1", addr_label="x"),
            ],
            ("verse", "verse_b"): [
                _LibChunk("verse_b", "verse", "B", "ru", source_id="s", tokens="1.2", addr_label="y"),
            ],
        },
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q"),
        "TopicExtractionResult": TopicExtractionResult(topics=["t"]),
    })
    result = await run_research(
        question="вопрос", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )
    texts = {e["text"] for e in result.research_chunks}
    assert {"A", "B"} <= texts


# ---- memory layer --------------------------------------------------------


def test_attach_memory_refs_are_authoritative() -> None:
    # Curator-picked refs ride with authoritative_refs (pinned ahead of the
    # reranked fanout pool), NOT thrown into the reranked research_chunks.
    result = ResearchResult(
        authoritative_refs=[{"type": "verse", "ref": 5}],
        research_chunks=[{"type": "verse", "ref": 1}],
    )
    env = {"type": "verse", "ref": 9}
    _attach_memory(result, MemoryResolution(
        note="Бэкграунд про Гиту.", attribution_id="attribution_m",
        envelopes=[env], score=0.88,
    ))
    assert result.memory_note == "Бэкграунд про Гиту."
    assert result.matched_memory_id == "attribution_m"
    assert env in result.authoritative_refs
    assert len(result.authoritative_refs) == 2
    # The reranked pool is untouched.
    assert env not in result.research_chunks
    assert len(result.research_chunks) == 1


def test_attach_memory_no_match_is_noop() -> None:
    result = ResearchResult(research_chunks=[{"type": "verse", "ref": 1}])
    _attach_memory(result, MemoryResolution())
    assert result.memory_note is None
    assert result.matched_memory_id is None
    assert len(result.research_chunks) == 1
    assert len(result.authoritative_refs) == 0


@pytest.mark.asyncio
async def test_resolve_memory_no_pool_is_noop() -> None:
    mem = await _resolve_memory(
        user_q_embedding=[0.1, 0.2],
        sub_query_texts=[],
        embedder=None,
        retrieval_lang_code="ru",
        answer_lang="ru",
        embed_model="m",
        embed_dim=1024,
        pool=None,
        chunk_repo=None,
        alias_map=None,
        library_db=None,
        catalog_repo=None,
        on_event=None,
    )
    assert not mem.matched
    assert (mem.note, mem.attribution_id, mem.envelopes) == (None, None, [])


@pytest.mark.asyncio
async def test_resolve_memory_probes_sub_queries(monkeypatch) -> None:
    """The lookup runs against the raw query AND each sub-query, keeping the
    best match — so a paraphrase the raw query misses still fires when a
    sub-query matches the trigger strongly."""
    import lectorium_chat.research.pipeline as pl

    class _Emb:
        async def embed_queries(self, texts):
            return [[0.0] for _ in texts]

    # Raw query → weak match (0.40); sub-query #2 → strong match (0.88).
    scores = iter([0.40, 0.20, 0.88])

    async def fake_find(**kwargs):
        s = next(scores)
        return [AttributionMatch(attribution_id="attribution_m", kind="memory",
                                 refs=[], score=s, stage="native")]

    async def fake_note(pool, aid, lang):
        return "note-body"

    monkeypatch.setattr(pl, "find_attributions", fake_find)
    monkeypatch.setattr(pl, "_fetch_memory_note", fake_note)

    mem = await _resolve_memory(
        user_q_embedding=[0.1],
        sub_query_texts=["структура Бхагавад-гиты", "темы частей"],
        embedder=_Emb(),
        retrieval_lang_code="ru", answer_lang="ru",
        embed_model="m", embed_dim=1024, pool=object(),
        chunk_repo=None, alias_map=None, library_db=None,
        catalog_repo=None, on_event=None,
    )
    # Best across all 3 probes (raw + 2 sub-queries) is the 0.88 one → fires.
    assert mem.attribution_id == "attribution_m"
    assert mem.note == "note-body"
    assert mem.score == 0.88


@pytest.mark.asyncio
async def test_memory_only_takes_lean_path(monkeypatch) -> None:
    """A strong memory match with NO pinned attribution → the sufficiency gate
    returns CORRECT and run_research takes the LEAN path: the memory's shlokas
    ride as authoritative_refs, the note is set, and the WIDE topic lookup never
    runs. This is the new branch the sufficiency gate added (#1068).

    Memory is judge-gated (#1141): cosine alone never seats an authoritative note,
    so the strong cosine here still has to clear the border judge. With no reranker
    wired, that judge is the LLM confirm — scripted YES below (fed the curated
    variant phrasing this fake serves for `attribution_mem`)."""
    import types

    import lectorium_chat.research.pipeline as pl

    async def fake_note(pool, aid, lang):
        return "Гиту можно читать как доказательство в три шага."

    monkeypatch.setattr(pl, "_fetch_memory_note", fake_note)

    pool = FakePool(
        rows={
            # memory match clears the recall floor; no pinned/boost.
            ("ru", "memory"): [_row("attribution_mem", 0.90, [
                {"ref_kind": "verse", "target_id": "verse_BG_6_47"},
                {"ref_kind": "verse", "target_id": "verse_BG_7_7"},
                {"ref_kind": "verse", "target_id": "verse_BG_9_22"},
            ])],
        },
        # Curated phrasing the border judge reads to confirm the match.
        variant_texts={"attribution_mem": ["структура Бхагавад-гиты"]},
    )
    chunk_repo = FakeChunkRepo(by_target={
        ("verse", "verse_BG_6_47"): [_LibChunk("verse_BG_6_47", "verse", "6.47", "ru", source_id="src", tokens="6.47", addr_label="БГ 6.47")],
        ("verse", "verse_BG_7_7"): [_LibChunk("verse_BG_7_7", "verse", "7.7", "ru", source_id="src", tokens="7.7", addr_label="БГ 7.7")],
        ("verse", "verse_BG_9_22"): [_LibChunk("verse_BG_9_22", "verse", "9.22", "ru", source_id="src", tokens="9.22", addr_label="БГ 9.22")],
    })
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("структура Бхагавад-гиты"),
        # Border judge confirms the memory match.
        "Confirm": types.SimpleNamespace(yes=True),
    })

    result = await run_research(
        question="структура Бхагавад-гиты", lang="ru", router_args={},
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    # memory-only CORRECT → lean: note set, 3 curator shlokas pinned as
    # authoritative, and NO topic-attribution lookup (that's the WIDE path).
    assert result.memory_note == "Гиту можно читать как доказательство в три шага."
    assert result.matched_memory_id == "attribution_mem"
    assert result.matched_question_ids == []   # no pinned
    assert result.matched_topic_ids == []      # WIDE path never ran
    tokens = sorted(e["meta"]["tokens"] for e in result.authoritative_refs)
    assert tokens == ["6.47", "7.7", "9.22"]


@pytest.mark.asyncio
async def test_a_selection_with_no_lectures_leaves_no_lecture_note_anywhere():
    """The whole pipeline, driven exactly as the worker drives it.

    The production probe kept finding transcript citations under a selection
    whose lecturer has ZERO lectures in the corpus, and every unit test passed —
    because each pinned one lane in isolation. This one runs the real
    `run_research` with a scope that resolves to no tracks, while the corpus
    would happily hand back a lecture from any lane that forgets to ask: the
    fanout, and a track pinned by attribution.
    """
    pool = FakePool({
        # A question match that pins a TRACK — the path that bypasses every
        # eligible-id filter, since it arrives by link rather than by search.
        ("ru", "pinned"): [
            _row("attribution_q1", 0.92, [
                {"ref_kind": "track", "target_id": "track_theirs@1000-2000"},
            ]),
        ],
        (None, "pinned"): [],
        ("ru", "boost"): [],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_theirs", 1000, 2000, "ЛЕКЦИЯ ДРУГОГО", "ru"), 0.95),
        ],
        library_results=[
            _Scored(_LibChunk("verse_bg_2_13", "verse", "СТИХ", "ru",
                              source_id="src", tokens="2.13", addr_label="БГ 2.13"), 0.6),
        ],
        by_target={
            ("track", "track_theirs@1000-2000"): [
                _LecChunk("track_theirs", 1000, 2000, "ЛЕКЦИЯ ДРУГОГО", "ru"),
            ],
        },
    )
    llm = FakeLLM(by_schema={"QueryPlan": _plan("q1")})

    scope = AuthorScope(catalog_repo=_NoTracksForAnyone(), request_id="req")
    scope.apply(AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=["author_chosen"], explicit=True),
    }))

    result = await run_research(
        question="как развить смирение", lang="ru", router_args={},
        author_scope=scope,
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    notes = list(result.research_chunks) + list(result.authoritative_refs)
    lectures = [n for n in notes if n.get("type") == "lecture"]
    assert lectures == [], f"a lecture reached the answer: {lectures}"
    # And the books are untouched — the selection narrows lecturers, not canon.
    assert any(n.get("type") == "verse" for n in notes)


@pytest.mark.asyncio
async def test_the_long_path_narrows_its_fanout_rounds_too():
    """Same guarantee on the LONG path, which is what production actually took.

    A topic match with no pinned question sends the turn through topic lookup
    and the multi-round fanout — different code from the lean path above, and
    the rounds are where a live probe found 31 other lecturers' talks.
    """
    pool = FakePool({
        ("ru", "pinned"): [],
        (None, "pinned"): [],
        ("ru", "boost"): [
            _row("attribution_t1", 0.75, [
                {"ref_kind": "track", "target_id": "track_theirs@1000-2000"},
            ]),
        ],
    })
    chunk_repo = FakeChunkRepo(
        lecture_results=[
            _Scored(_LecChunk("track_theirs", 1000, 2000, "ЛЕКЦИЯ ДРУГОГО", "ru"), 0.95),
        ],
        library_results=[
            _Scored(_LibChunk("verse_bg_2_13", "verse", "СТИХ", "ru",
                              source_id="src", tokens="2.13", addr_label="БГ 2.13"), 0.6),
        ],
        by_target={
            ("track", "track_theirs@1000-2000"): [
                _LecChunk("track_theirs", 1000, 2000, "ЛЕКЦИЯ ДРУГОГО", "ru"),
            ],
        },
    )
    llm = FakeLLM(by_schema={
        "QueryPlan": _plan("q1", "q2"),
        "TopicExtractionResult": TopicExtractionResult(topics=["смирение"]),
    })

    scope = AuthorScope(catalog_repo=_NoTracksForAnyone(), request_id="req")
    scope.apply(AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=["author_chosen"], explicit=True),
    }))

    result = await run_research(
        question="как развить смирение", lang="ru", router_args={},
        author_scope=scope,
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    notes = list(result.research_chunks) + list(result.authoritative_refs)
    lectures = [n for n in notes if n.get("type") == "lecture"]
    assert lectures == [], f"a lecture reached the answer: {lectures}"
    assert chunk_repo.fanout_calls == 0, (
        "the lecture lane called the corpus even though the selection allows no "
        "track — the lane must be disabled, not filtered after the fact"
    )


class _NoTracksForAnyone:
    """Catalog where the chosen lecturer has nothing — the corpus knows them,
    they simply never spoke a recorded word."""

    async def filter_track_ids(self, **_kw):
        return []

    async def get_author_names(self, author_ids, *, lang):
        return {a: "Выбранный" for a in author_ids}

    async def language_name(self, code):
        return None
