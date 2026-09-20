"""Attribution lookup over the curated `attributions` mirror.

The SQL lives behind `ChunkRepository.find_attributions` /
`.attribution_texts`; this module owns only the scoring policy.

Two-stage with asymmetric thresholds:
  1. NATIVE: filter by user's language. Lower-bound = accept_native.
  2. CROSS: if native top1 < border, retry across all languages with
     accept_cross (slightly lower to compensate cross-lingual penalty).

pinned kind (critical): border-zone (0.70..accept_native) triggers an
optional LLM-confirm for the top1; rejection there returns [].
boost kind: no LLM-confirm — the boost is not worth a second LLM round-trip.

Multi-match: up to `max_matches` attributions above accept threshold are
returned. The synthesizer / fanout consumes the union of their refs.
"""

from __future__ import annotations

from typing import Any, Literal

from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.constants import (
    PINNED_ACCEPT_SCORE_CROSS,
    PINNED_ACCEPT_SCORE_NATIVE,
    PINNED_BORDER_SCORE,
    PINNED_MAX_MATCHES,
    PINNED_RERANK_ACCEPT,
    PINNED_RERANK_CANDIDATE_POOL,
    BOOST_ACCEPT_SCORE_CROSS,
    BOOST_ACCEPT_SCORE_NATIVE,
    BOOST_MAX_MATCHES_PER_TOPIC,
    MEMORY_ACCEPT_SCORE_CROSS,
    MEMORY_ACCEPT_SCORE_NATIVE,
    MEMORY_GATE,
    MEMORY_MAX_MATCHES,
    MEMORY_RECALL_FLOOR,
    MEMORY_RERANK_ACCEPT,
)
from lectorium_chat.research.models import AttributionMatch, AttributionRef


log = get_logger(__name__)


# Lookup is parameterised so the same helper covers pinned + boost.
async def find_attributions(
    *,
    kind: Literal["pinned", "boost", "memory"],
    user_q_embedding: list[float],
    lang: str,
    chunk_repo: Any,                     # ChunkRepository — owns the SQL
    reranker: Any | None = None,         # cross-encoder gate for border-zone pinned
    user_query: str | None = None,       # raw query text — needed by the gate
    llm: Any | None = None,              # fixed-prompt fallback when reranker absent
    confirm_model: str | None = None,
    accept_native: float | None = None,
    accept_cross: float | None = None,
    border_score: float | None = None,
    max_matches: int | None = None,
) -> list[AttributionMatch]:
    """Two-stage native + cross-lingual lookup. See module docstring."""

    if kind == "pinned":
        an = accept_native if accept_native is not None else PINNED_ACCEPT_SCORE_NATIVE
        ac = accept_cross if accept_cross is not None else PINNED_ACCEPT_SCORE_CROSS
        bs = border_score if border_score is not None else PINNED_BORDER_SCORE
        mm = max_matches if max_matches is not None else PINNED_MAX_MATCHES
    elif kind == "boost":
        an = accept_native if accept_native is not None else BOOST_ACCEPT_SCORE_NATIVE
        ac = accept_cross if accept_cross is not None else BOOST_ACCEPT_SCORE_CROSS
        bs = None  # topic does not use LLM-confirm
        mm = max_matches if max_matches is not None else BOOST_MAX_MATCHES_PER_TOPIC
    elif kind == "memory":
        # Judge-gated memory. A matched memory note is AUTHORITATIVE (it anchors
        # the whole outline), so cosine alone must not seat it. Set the
        # auto-accept bar unreachable and the border floor to a LOW recall value:
        # every match in `[floor, ∞)` is routed through the cross-encoder/LLM
        # gate below (the pinned border path), which actually reads the query ×
        # the note's phrasings and rejects off-topic false matches.
        if MEMORY_GATE:
            an = ac = 1.01
            bs = MEMORY_RECALL_FLOOR
        else:
            an = accept_native if accept_native is not None else MEMORY_ACCEPT_SCORE_NATIVE
            ac = accept_cross if accept_cross is not None else MEMORY_ACCEPT_SCORE_CROSS
            bs = None
        mm = max_matches if max_matches is not None else MEMORY_MAX_MATCHES
    else:
        return []

    # Stage 1 — NATIVE lang. MAX(score) per attribution (one attribution may
    # have N text variants; we want its best variant for THIS user query).
    native = await _query(chunk_repo, user_q_embedding, kind, lang=lang)
    accepted_native = [m for m in native if m.score >= an]
    if accepted_native:
        return _take(accepted_native, mm, stage="native")

    # NATIVE below `an` but the top NATIVE score already clears the cross
    # threshold `ac` → accept as native without a second query. Boost only:
    # for a `pinned` attribution the cross bar `ac` sits BELOW the native bar
    # `an`, so admitting native matches at `>= ac` would seat a sub-native-bar
    # curated pin UNJUDGED — exactly the band the border gate below
    # (`[bs, ac)` and onward) exists to cross-encoder-confirm. Excluding pinned
    # here lets those scores fall through to that judged path instead.
    if kind != "pinned" and native and native[0].score >= ac:
        accepted = [m for m in native if m.score >= ac]
        return _take(accepted, mm, stage="native")

    # Border-zone (pinned only) — the TRUE uncertain band `[bs, ac)`. Cosine
    # alone can't assert a curated attribution here; re-judge top1 with the
    # cross-encoder gate (LLM fallback inside). No confirmation ⇒ reject.
    if kind in ("pinned", "memory") and bs is not None and native and native[0].score >= bs:
        top = native[0]
        if await _gate_border(
            native, top, lang,
            reranker=reranker, user_query=user_query, chunk_repo=chunk_repo,
            llm=llm, model=confirm_model,
            rerank_accept=MEMORY_RERANK_ACCEPT if kind == "memory" else PINNED_RERANK_ACCEPT,
        ):
            return [_with_stage(top, "native")]
        # Explicit no — fall through, do NOT try cross stage (the closest
        # native-lang attribution was rejected; a worse cross-lang match is
        # not going to be better).
        return []

    cross = await _query(chunk_repo, user_q_embedding, kind, lang=None)
    accepted_cross = [m for m in cross if m.score >= ac]
    if accepted_cross:
        return _take(accepted_cross, mm, stage="cross")

    # Cross-stage border-zone also goes through the cross-encoder gate.
    if kind in ("pinned", "memory") and bs is not None and cross and cross[0].score >= bs:
        top = cross[0]
        if await _gate_border(
            cross, top, lang,
            reranker=reranker, user_query=user_query, chunk_repo=chunk_repo,
            llm=llm, model=confirm_model,
            rerank_accept=MEMORY_RERANK_ACCEPT if kind == "memory" else PINNED_RERANK_ACCEPT,
        ):
            return [_with_stage(top, "cross")]

    return []


# ---- helpers --------------------------------------------------------------


async def _query(
    chunk_repo: Any,
    user_q_embedding: list[float],
    kind: str,
    *,
    lang: str | None,
) -> list[AttributionMatch]:
    """One attribution lookup, mapped onto the research model.

    The repository returns the top candidates already deduped to their best
    variant per attribution; this turns the raw `refs` maps into typed
    `AttributionRef`s and stamps the stage the caller is in."""
    candidates = await chunk_repo.find_attributions(
        user_q_embedding, kind=kind, lang=lang,
    )

    out: list[AttributionMatch] = []
    for c in candidates:
        refs = [
            AttributionRef(
                ref_kind=ref.get("ref_kind", ""),
                target_id=ref.get("target_id", ""),
                language=ref.get("language") or "",
            )
            for ref in c.refs
            if ref.get("target_id")
        ]
        out.append(AttributionMatch(
            attribution_id=c.attribution_id,
            kind=kind,                  # type: ignore[arg-type]
            refs=refs,
            score=float(c.score),
            stage="native" if lang is not None else "cross",
        ))
    return out


async def _gate_border(
    candidates: list[AttributionMatch],
    top: AttributionMatch,
    lang: str,
    *,
    reranker: Any | None,
    user_query: str | None,
    chunk_repo: Any,
    llm: Any | None,
    model: str | None,
    rerank_accept: float = PINNED_RERANK_ACCEPT,
) -> bool:
    """Decide whether a border-zone (0.70..accept) pinned match is real.

    A border match scored BELOW the accept threshold — cosine alone is not
    enough to assert a hand-curated, authoritative attribution. A judge has
    to actively confirm it. When no judge can run (no reranker AND no LLM,
    no usable texts, every judge errored), we REJECT: returning the match
    anyway would surface a curated "this is THE source" answer on nothing
    but a sub-threshold cosine — a fabricated authoritative attribution,
    the worst failure mode for this product. Rejecting just falls through
    to the cross stage / ordinary fanout, which still surfaces relevant
    material without the false authority.

    Order of judges, strongest first:
      1. Cross-encoder (Voyage): score (user query × each curated phrasing) as a
         pair and accept iff the top candidate's best phrasing ≥ threshold. This
         is the same model the fanout ranks with — it actually reads both texts.
      2. LLM fallback (only if no reranker): a fixed-prompt yes/no, fed the
         REAL query and the REAL canonical phrasings.
      3. No judge available / all judges errored → REJECT (do not assert a
         border match without confirmation).
    """
    if reranker is not None and user_query:
        decided = await _rerank_gate(
            reranker, chunk_repo, user_query, candidates, top, lang,
            accept=rerank_accept,
        )
        if decided is not None:
            return decided

    if llm is not None and user_query:
        texts = await chunk_repo.attribution_texts(top.attribution_id, lang=lang)
        if texts:
            return await _confirm_llm(llm, user_query, texts, lang, top.score, model=model)

    log.info(
        "attribution_border_no_judge_rejected",
        attribution_id=top.attribution_id,
        cosine=round(top.score, 3),
    )
    return False


async def _rerank_gate(
    reranker: Any,
    chunk_repo: Any,
    query: str,
    candidates: list[AttributionMatch],
    top: AttributionMatch,
    lang: str,
    *,
    accept: float = PINNED_RERANK_ACCEPT,
) -> bool | None:
    """Cross-encoder accept/reject for the top border candidate. Returns the
    decision, or None when it can't be made (no usable texts / Voyage no-ops on
    <2 documents / API error) so the caller falls back to the LLM judge.

    Reranks the curated phrasings of the top-N border candidates in one call.
    The cross-encoder scores each (query, phrasing) pair independently, so the
    extra candidates don't perturb the top's score — they only guarantee Voyage
    sees ≥2 documents and give a natural multi-match contrast."""
    docs: list[str] = []
    owner: list[str] = []
    for m in candidates[:PINNED_RERANK_CANDIDATE_POOL]:
        for txt in await chunk_repo.attribution_texts(m.attribution_id, lang=lang):
            docs.append(txt)
            owner.append(m.attribution_id)
    if len(docs) < 2:
        return None  # Voyage no-ops on ≤1 doc → let the caller fall back.

    try:
        scored = await reranker.rerank(query, docs)
    except Exception as exc:  # noqa: BLE001 — best-effort; fall back on failure
        log.warning("attribution_rerank_failed", error=str(exc), attribution_id=top.attribution_id)
        return None

    best = -1.0
    for idx, score in scored:
        if 0 <= idx < len(owner) and owner[idx] == top.attribution_id:
            best = max(best, score)
    if best < 0:
        return None  # top had no scored doc — shouldn't happen, but be safe.

    accepted = best >= accept
    log.info(
        "attribution_rerank_gate",
        attribution_id=top.attribution_id,
        cosine=round(top.score, 3),
        rerank=round(best, 3),
        threshold=accept,
        accepted=accepted,
    )
    return accepted


async def _confirm_llm(
    llm: Any,
    user_query: str,
    canonical_texts: list[str],
    lang: str,
    score: float,
    *,
    model: str | None = None,
) -> bool:
    """Fixed-prompt LLM yes/no — the reranker-less fallback. It is fed the
    REAL user query and the REAL curated phrasings, so the model can actually
    compare. Returns True only on an explicit YES; an error / unparseable
    response REJECTS — a border match is sub-threshold cosine, so without a
    positive confirmation we must not assert a curated authoritative
    attribution (it would be a fabricated source). Rejecting falls through to
    the ordinary fanout."""
    from pydantic import BaseModel, Field

    class Confirm(BaseModel):
        yes: bool = Field(description="True if a curated phrasing asks essentially the user's question")

    system = (
        "You are a routing helper. Given a user query and a list of curated "
        "canonical phrasings, answer YES if ANY phrasing is asking essentially "
        "the same thing (any wording). Answer NO only if they are about different "
        "topics. Output strict JSON: {\"yes\": true|false}."
    )
    bullets = "\n".join(f"- {t}" for t in canonical_texts[:10])
    user = (
        f"User query (lang={lang}): {user_query}\n\n"
        f"Curated phrasings:\n{bullets}\n\n"
        f"(retrieval cosine was {score:.2f} — borderline)"
    )
    try:
        result: Confirm = await llm.structured_output(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            Confirm,
            model=model,
            run_name="attribution_confirm",
        )
        return bool(result.yes)
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning("attribution_confirm_failed", error=str(exc))
        return False  # no positive confirmation → reject a border match


def _take(matches: list[AttributionMatch], n: int, *, stage: Literal["native", "cross"]) -> list[AttributionMatch]:
    return [_with_stage(m, stage) for m in matches[:max(1, n)]]


def _with_stage(m: AttributionMatch, stage: Literal["native", "cross"]) -> AttributionMatch:
    # Dataclass is frozen — return a copy with `stage` overridden.
    return AttributionMatch(
        attribution_id=m.attribution_id,
        kind=m.kind,
        refs=m.refs,
        score=m.score,
        stage=stage,
    )
