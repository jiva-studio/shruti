"""Unit tests for research.attribution_lookup.

Uses an in-memory fake pool that returns scripted rows per (lang, kind).
Postgres-backed integration is covered in tests/integration/test_attribution_full_flow.py.
"""

from __future__ import annotations

import json
from typing import Any  # noqa: F401

import pytest
from pydantic import BaseModel  # noqa: F401

from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.models import AttributionMatch  # noqa: F401


# ---- fake asyncpg-shaped pool ---------------------------------------------


class _FakeRow(dict):
    """Dict subclass mimicking asyncpg.Record (supports __getitem__)."""


class FakeConn:
    def __init__(
        self,
        rows_by_query: dict[tuple, list[_FakeRow]],
        texts_by_attr: dict[str, list[str]] | None = None,
    ) -> None:
        self.rows_by_query = rows_by_query
        # Curated phrasings per attribution_id, returned by the border gate's
        # `_fetch_variant_texts`. Defaults to one phrasing per seen attribution.
        self.texts_by_attr = texts_by_attr or {}
        self.calls: list[tuple] = []

    async def fetch(self, sql: str, *args) -> list[_FakeRow]:
        # Border gate's variant-text fetch:
        #   "SELECT DISTINCT text ... WHERE attribution_id=$1 AND embed_model=$2 [AND language=$3]"
        if sql.lstrip().startswith("SELECT DISTINCT text"):
            attribution_id = args[0]
            self.calls.append(("texts", attribution_id))
            return [_FakeRow(text=t) for t in self.texts_by_attr.get(attribution_id, [])]
        # Lookup. Args layout differs by stage:
        #   native: (embedding, lang, embed_model, kind)
        #   cross:  (embedding, embed_model, kind)
        if "WHERE e.language" in sql:
            lang, _embed_model, kind = args[1], args[2], args[3]
            self.calls.append(("native", lang, kind))
            key = (lang, kind)
        else:
            _embed_model, kind = args[1], args[2]
            self.calls.append(("cross", None, kind))
            key = (None, kind)
        return self.rows_by_query.get(key, [])


class FakeReranker:
    """Cross-encoder stub: scores every (query, doc) pair with a fixed
    relevance, mirroring VoyageReranker's `(orig_index, score)` contract."""

    def __init__(self, score: float) -> None:
        self.score = score
        self.calls: list[tuple[str, list[str]]] = []

    async def rerank(self, query: str, documents: list[str], *, top_k=None):
        self.calls.append((query, list(documents)))
        if len(documents) <= 1:
            return [(i, 0.0) for i in range(len(documents))]
        return [(i, self.score) for i in range(len(documents))]


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def acquire(self):
        # asyncpg's acquire() returns an async context manager.
        return _AcquireCtx(self.conn)


class _AcquireCtx:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    async def __aenter__(self) -> FakeConn:
        return self.conn

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


def _row(aid: str, score: float, refs: list[dict] | None = None) -> _FakeRow:
    return _FakeRow(
        id=aid,
        refs_json=json.dumps(refs or [{"ref_kind": "verse", "target_id": "verse_x"}]),
        score=score,
    )


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_native_match_accepted_above_threshold() -> None:
    conn = FakeConn({("ru", "pinned"): [_row("attribution_a", 0.92)]})
    pool = FakePool(conn)
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="openai/text-embedding-3-small", embed_dim=1536, pool=pool,
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "attribution_a"
    assert matches[0].stage == "native"
    assert matches[0].score == pytest.approx(0.92)


@pytest.mark.asyncio
async def test_multi_match_returns_top_k_above_accept() -> None:
    conn = FakeConn({("ru", "pinned"): [
        _row("a1", 0.95), _row("a2", 0.93), _row("a3", 0.91),
        _row("a4", 0.87), _row("a5", 0.83),
    ]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    # 4 are >= 0.85, but cap at PINNED_MAX_MATCHES=3
    assert [m.attribution_id for m in matches] == ["a1", "a2", "a3"]


@pytest.mark.asyncio
async def test_native_below_accept_falls_to_cross() -> None:
    # Native top1 is 0.78 — below 0.85 (accept_native), above 0.70 (border).
    # Border-zone triggers LLM-confirm. Pass an llm that returns NO so we
    # see the path actually fall through to []... wait, on no we return [].
    # Use a different test: native top is below 0.70 → straight to cross.
    conn = FakeConn({
        ("ru", "pinned"): [_row("a1", 0.50)],  # below border
        (None, "pinned"): [_row("a1", 0.82)],  # cross above accept_cross (0.80)
    })
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.82)


@pytest.mark.asyncio
async def test_border_zone_reranker_accepts_above_threshold() -> None:
    # Border-zone cosine 0.78; the cross-encoder scores the curated phrasing
    # 0.80 ≥ PINNED_RERANK_ACCEPT (0.50) → keep. No LLM needed.
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["неграмотный брахман плакал над Гитой", "брахман и Гита"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        reranker=FakeReranker(0.80), user_query="история про брахмана и Гиту",
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "a1"


@pytest.mark.asyncio
async def test_border_zone_reranker_rejects_below_threshold() -> None:
    # Same border cosine, but the cross-encoder says 0.20 < 0.50 → reject.
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["совсем другая тема", "ещё одна формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        reranker=FakeReranker(0.20), user_query="что-то совершенно иное",
    )
    assert matches == []


@pytest.mark.asyncio
async def test_border_zone_reranker_single_doc_falls_back_to_llm() -> None:
    # Only ONE phrasing total → Voyage no-ops on <2 docs → gate falls back to
    # the (now correctly-fed) LLM judge, which says YES here.
    class YesLLM:
        def __init__(self): self.seen = None
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            self.seen = messages[-1]["content"]
            return schema(yes=True)

    llm = YesLLM()
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["единственная формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        reranker=FakeReranker(0.99), user_query="живой запрос пользователя",
        llm=llm,
    )
    assert len(matches) == 1
    # The LLM fallback was actually fed the real query + canonical text
    # (the bug this PR fixes — old code passed "<unknown>").
    assert "живой запрос пользователя" in llm.seen
    assert "единственная формулировка" in llm.seen


@pytest.mark.asyncio
async def test_border_zone_llm_fallback_says_no_returns_empty() -> None:
    # No reranker → LLM judge, fed real query+texts, says NO → drop.
    class NoLLM:
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            return schema(yes=False)

    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["каноническая формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        user_query="запрос про другое", llm=NoLLM(),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_border_zone_llm_error_rejects_match() -> None:
    # No reranker → LLM judge, but the judge RAISES. Without a positive
    # confirmation we must REJECT (a border match is sub-threshold cosine;
    # accepting on judge failure fabricates an authoritative attribution).
    class BoomLLM:
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            raise RuntimeError("judge unavailable")

    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["каноническая формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        user_query="запрос", llm=BoomLLM(),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_border_zone_no_judge_rejects_match() -> None:
    # True border zone (0.78 ∈ [0.70, 0.80)) with NEITHER reranker nor llm
    # available → no judge can confirm. We must REJECT rather than assert a
    # curated authoritative attribution on a sub-threshold cosine alone
    # (fabricated-source guard). Falls through to the empty result.
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_topic_no_llm_confirm_lower_thresholds() -> None:
    # Topic with score 0.66 in cross-stage — passes BOOST_ACCEPT_SCORE_CROSS=0.65.
    conn = FakeConn({
        ("ru", "boost"): [_row("t1", 0.30)],
        (None, "boost"): [_row("t1", 0.66)],
    })
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.66)


@pytest.mark.asyncio
async def test_topic_native_threshold_separate_from_cross() -> None:
    # Topic native at 0.71 — passes BOOST_ACCEPT_SCORE_NATIVE=0.70.
    conn = FakeConn({("ru", "boost"): [_row("t1", 0.71)]})
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "native"


@pytest.mark.asyncio
async def test_empty_table_returns_empty_no_errors() -> None:
    conn = FakeConn({})  # no rows for any (lang, kind)
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_refs_parsed_from_jsonb() -> None:
    conn = FakeConn({("ru", "pinned"): [_row("a1", 0.90, refs=[
        {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
        {"ref_kind": "document", "target_id": "library_document_x"},
    ])]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches[0].refs) == 2
    assert matches[0].refs[0].ref_kind == "verse"
    assert matches[0].refs[0].target_id == "verse_BG_2_13"
    assert matches[0].refs[1].ref_kind == "document"


@pytest.mark.asyncio
async def test_pinned_native_in_cross_band_is_judged_not_auto_promoted() -> None:
    # Native top1 is 0.81 — below 0.85 accept_native, above 0.80 accept_cross.
    # For a PINNED (curated) attribution this is BELOW the native bar: it must
    # NOT be auto-promoted to native unjudged just because it clears the looser
    # cross bar. With no reranker/LLM judge available the border gate can't
    # confirm it → reject (the fabricated-source guard), exactly like the
    # 0.78 border case. (Boost still early-accepts; see the topic tests.)
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.81)]},
        texts_by_attr={"a1": ["формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert matches == []
    # No second cross-lang SQL — the native border gate decided it.
    assert len(conn.calls) == 1
    assert conn.calls[0][0] == "native"


@pytest.mark.asyncio
async def test_pinned_native_in_cross_band_accepted_when_judge_confirms() -> None:
    # Same 0.81 native cosine, but now the cross-encoder confirms the curated
    # phrasing → accept as a NATIVE-stage match (the judged path the cross-band
    # pin now flows through instead of the old unjudged auto-promote).
    conn = FakeConn(
        {("ru", "pinned"): [_row("a1", 0.81)]},
        texts_by_attr={"a1": ["неграмотный брахман плакал над Гитой", "брахман и Гита"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
        reranker=FakeReranker(0.80), user_query="история про брахмана и Гиту",
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "a1"
    assert matches[0].stage == "native"
    # Native border gate decided it — no second cross-LANG SQL was issued
    # (the gate's curated-text fetch is not a cross-stage query).
    assert not any(c[0] == "cross" for c in conn.calls)
