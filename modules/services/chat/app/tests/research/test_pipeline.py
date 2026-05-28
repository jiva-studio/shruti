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

from lectorium_chat.research.models import (
    AttributionMatch,
    AttributionRef,
    QueryPlan,
    SubQuery,
    TopicExtractionResult,
)
from lectorium_chat.research.pipeline import run_research


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


class FakeCatalogRepo:
    async def filter_track_ids(self, **_kwargs) -> list[str] | None:
        return None


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

    def alias_chunk(self, track_id, start_ms, end_ms):
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

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences):
        self._verse += 1
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
    """asyncpg-shaped fake. Stores rows keyed by (kind, lang)."""

    def __init__(self, rows: dict[tuple, list[dict]] | None = None) -> None:
        self.rows = rows or {}

    def acquire(self):
        return _Acq(self.rows)


class _Acq:
    def __init__(self, rows: dict[tuple, list[dict]]):
        self.rows = rows
        self.conn = _FakeConn(rows)

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return None


class _FakeConn:
    def __init__(self, rows: dict[tuple, list[dict]]):
        self.rows = rows

    async def fetch(self, sql, *args):
        if "WHERE e.language" in sql:
            lang, _embed_model, kind = args[1], args[2], args[3]
            return [dict(r) for r in self.rows.get((lang, kind), [])]
        _embed_model, kind = args[1], args[2]
        return [dict(r) for r in self.rows.get((None, kind), [])]


def _row(aid: str, score: float, refs: list[dict]) -> dict:
    import json
    return {"id": aid, "refs_json": json.dumps(refs), "score": score}


def _common_kwargs(*, llm, pool, chunk_repo=None, embedder=None) -> dict:
    return {
        "chunk_repo": chunk_repo or FakeChunkRepo(),
        "catalog_repo": FakeCatalogRepo(),
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
        ("ru", "question"): [
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
        ("ru", "question"): [
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
async def test_long_path_no_question_match():
    """No question match → extract_topics → topic lookup → boost → fanout."""
    pool = FakePool({
        # No question matches.
        ("ru", "question"): [],
        (None, "question"): [],
        # Topic match returns refs to verse_boost.
        ("ru", "topic"): [
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
    # Boost: verse_boost should now score 0.55 + 0.15 = 0.70 → above verse_other (0.65).
    texts = [e["text"] for e in result.research_chunks]
    assert texts[0] == "BOOSTED"
    # Boosted flag set.
    assert result.research_chunks[0]["topic_boosted"] is True


@pytest.mark.asyncio
async def test_long_path_no_topics_extracted_no_boost():
    """LLM returns 0 topics → boost_ids empty → fanout runs without boost."""
    pool = FakePool({("ru", "question"): []})
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
    """Both lookups return [] → boost_ids empty → plain fanout. No crash."""
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
    pool = FakePool({("ru", "question"): []})
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
    pool = FakePool({("ru", "question"): []})
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
    assert captured[0]["author_id"] == "author_p"
    assert captured[0]["tag_ids"] == ["t1"]
    assert captured[0]["date_from"] == "1972-01-01"


@pytest.mark.asyncio
async def test_authoritative_carries_canonical_score():
    """Authoritative envelopes MUST carry score = top_match.score so the
    synthesizer doesn't refuse them as junk (score < 0.45)."""
    pool = FakePool({
        ("ru", "question"): [
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
        ("ru", "question"): [
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
    # Two attribution refs → two research_source events (one per ref,
    # emitted before each DB round-trip).
    source_ids = sorted(s["id"] for s in sources if s["id"].startswith(("verse:", "library:")))
    assert "verse:verse_BG_2_13" in source_ids
    assert "library:doc_letter_42" in source_ids
    # Wire kind discriminator is correct.
    by_id = {s["id"]: s for s in sources}
    assert by_id["verse:verse_BG_2_13"]["kind"] == "verse"
    assert by_id["library:doc_letter_42"]["kind"] == "library_doc"
    # Issue #660: the pre-fetch source emission must NOT leak the raw
    # target_id as the user-visible label. Use a kind-aware generic
    # string until the DB round-trip surfaces the real addr_label.
    assert by_id["verse:verse_BG_2_13"]["label"] == "verse"
    assert by_id["library:doc_letter_42"]["label"] == "library document"


@pytest.mark.asyncio
async def test_on_event_emits_research_sources_from_fanout():
    """LONG path: corpus_fanout emits research_source per inspected raw
    chunk (lecture / verse / library), keyed for client-side dedup."""
    pool = FakePool({
        ("ru", "question"): [],
        (None, "question"): [],
        ("ru", "topic"): [],
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
        **_common_kwargs(llm=llm, pool=pool, chunk_repo=chunk_repo),
    )

    sources = [d for t, d in events if t == "research_source"]
    by_id = {s["id"]: s for s in sources}

    # Lecture chunk → kind="lecture_chunk", id includes start_ms.
    assert "lecture:track_A:60000" in by_id
    assert by_id["lecture:track_A:60000"]["kind"] == "lecture_chunk"
    # Label is a snippet of the chunk text, not the opaque track_id.
    assert "first words" in by_id["lecture:track_A:60000"]["label"]

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
    pool = FakePool({("ru", "question"): []})
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
    pool = FakePool({("ru", "question"): []})
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
