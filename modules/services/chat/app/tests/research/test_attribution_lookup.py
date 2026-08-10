"""Unit tests for research.attribution_lookup.

Uses an in-memory fake repository that returns scripted candidates per
(lang, kind). Postgres-backed integration is covered in
tests/integration/test_attribution_full_flow.py.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from shruti_chat.domain.entities import AttributionCandidate
from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.models import AttributionMatch


# ---- fake attribution repository ------------------------------------------


class FakeAttributionRepo:
    """The `ChunkRepository` surface `find_attributions` consumes, scripted.

    `rows_by_query` maps (lang, kind) → candidates; `lang=None` is the
    cross-lingual stage. `texts_by_attr` holds the curated phrasings the
    border gate reranks / LLM-confirms against. Every call is recorded so a
    test can assert WHICH stages ran.
    """

    def __init__(
        self,
        rows_by_query: dict[tuple, list[AttributionCandidate]],
        texts_by_attr: dict[str, list[str]] | None = None,
    ) -> None:
        self.rows_by_query = rows_by_query
        self.texts_by_attr = texts_by_attr or {}
        self.calls: list[tuple] = []

    async def find_attributions(
        self, embedding: list[float], *, kind: str, lang: str | None,
    ) -> list[AttributionCandidate]:
        self.calls.append(("native" if lang is not None else "cross", lang, kind))
        return list(self.rows_by_query.get((lang, kind), []))

    async def attribution_texts(
        self, attribution_id: str, *, lang: str | None,
    ) -> list[str]:
        self.calls.append(("texts", attribution_id))
        return list(self.texts_by_attr.get(attribution_id, []))


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


def _row(aid: str, score: float, refs: list[dict] | None = None) -> AttributionCandidate:
    return AttributionCandidate(
        attribution_id=aid,
        refs=refs or [{"ref_kind": "verse", "target_id": "verse_x"}],
        score=score,
    )


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_native_match_accepted_above_threshold() -> None:
    repo = FakeAttributionRepo({("ru", "pinned"): [_row("attribution_a", 0.92)]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "attribution_a"
    assert matches[0].stage == "native"
    assert matches[0].score == pytest.approx(0.92)


@pytest.mark.asyncio
async def test_multi_match_returns_top_k_above_accept() -> None:
    repo = FakeAttributionRepo({("ru", "pinned"): [
        _row("a1", 0.95), _row("a2", 0.93), _row("a3", 0.91),
        _row("a4", 0.87), _row("a5", 0.83),
    ]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    # 4 are >= 0.85, but cap at PINNED_MAX_MATCHES=3
    assert [m.attribution_id for m in matches] == ["a1", "a2", "a3"]


@pytest.mark.asyncio
async def test_native_below_accept_falls_to_cross() -> None:
    # Native top1 is 0.78 — below 0.85 (accept_native), above 0.70 (border).
    # Border-zone triggers LLM-confirm. Pass an llm that returns NO so we
    # see the path actually fall through to []... wait, on no we return [].
    # Use a different test: native top is below 0.70 → straight to cross.
    repo = FakeAttributionRepo({
        ("ru", "pinned"): [_row("a1", 0.50)],  # below border
        (None, "pinned"): [_row("a1", 0.82)],  # cross above accept_cross (0.80)
    })
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.82)


@pytest.mark.asyncio
async def test_border_zone_reranker_accepts_above_threshold() -> None:
    # Border-zone cosine 0.78; the cross-encoder scores the curated phrasing
    # 0.80 ≥ PINNED_RERANK_ACCEPT (0.50) → keep. No LLM needed.
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["неграмотный брахман плакал над Гитой", "брахман и Гита"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
        reranker=FakeReranker(0.80), user_query="история про брахмана и Гиту",
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "a1"


@pytest.mark.asyncio
async def test_border_zone_reranker_rejects_below_threshold() -> None:
    # Same border cosine, but the cross-encoder says 0.20 < 0.50 → reject.
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["совсем другая тема", "ещё одна формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
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
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["единственная формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
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

    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["каноническая формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
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

    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["каноническая формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
        user_query="запрос", llm=BoomLLM(),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_border_zone_no_judge_rejects_match() -> None:
    # True border zone (0.78 ∈ [0.70, 0.80)) with NEITHER reranker nor llm
    # available → no judge can confirm. We must REJECT rather than assert a
    # curated authoritative attribution on a sub-threshold cosine alone
    # (fabricated-source guard). Falls through to the empty result.
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.78)]},
        texts_by_attr={"a1": ["формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert matches == []


@pytest.mark.asyncio
async def test_topic_no_llm_confirm_lower_thresholds() -> None:
    # Topic with score 0.66 in cross-stage — passes BOOST_ACCEPT_SCORE_CROSS=0.65.
    repo = FakeAttributionRepo({
        ("ru", "boost"): [_row("t1", 0.30)],
        (None, "boost"): [_row("t1", 0.66)],
    })
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.66)


@pytest.mark.asyncio
async def test_topic_native_threshold_separate_from_cross() -> None:
    # Topic native at 0.71 — passes BOOST_ACCEPT_SCORE_NATIVE=0.70.
    repo = FakeAttributionRepo({("ru", "boost"): [_row("t1", 0.71)]})
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert len(matches) == 1
    assert matches[0].stage == "native"


@pytest.mark.asyncio
async def test_empty_table_returns_empty_no_errors() -> None:
    repo = FakeAttributionRepo({})  # no rows for any (lang, kind)
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert matches == []


@pytest.mark.asyncio
async def test_refs_mapped_into_typed_refs() -> None:
    repo = FakeAttributionRepo({("ru", "pinned"): [_row("a1", 0.90, refs=[
        {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
        {"ref_kind": "document", "target_id": "library_document_x"},
    ])]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
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
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.81)]},
        texts_by_attr={"a1": ["формулировка"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
    )
    assert matches == []
    # No second cross-lang SQL — the native border gate decided it.
    assert len(repo.calls) == 1
    assert repo.calls[0][0] == "native"


@pytest.mark.asyncio
async def test_pinned_native_in_cross_band_accepted_when_judge_confirms() -> None:
    # Same 0.81 native cosine, but now the cross-encoder confirms the curated
    # phrasing → accept as a NATIVE-stage match (the judged path the cross-band
    # pin now flows through instead of the old unjudged auto-promote).
    repo = FakeAttributionRepo(
        {("ru", "pinned"): [_row("a1", 0.81)]},
        texts_by_attr={"a1": ["неграмотный брахман плакал над Гитой", "брахман и Гита"]},
    )
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        chunk_repo=repo,
        reranker=FakeReranker(0.80), user_query="история про брахмана и Гиту",
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "a1"
    assert matches[0].stage == "native"
    # Native border gate decided it — no second cross-LANG SQL was issued
    # (the gate's curated-text fetch is not a cross-stage query).
    assert not any(c[0] == "cross" for c in repo.calls)
