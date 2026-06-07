"""Attribution lookup against the Postgres `attributions` /
`attribution_embeddings` mirror.

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

import json
from typing import Any, Literal

from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import (
    PINNED_ACCEPT_SCORE_CROSS,
    PINNED_ACCEPT_SCORE_NATIVE,
    PINNED_BORDER_SCORE,
    PINNED_MAX_MATCHES,
    PINNED_RERANK_ACCEPT,
    PINNED_RERANK_CANDIDATE_POOL,
    BOOST_ACCEPT_SCORE_CROSS,
    BOOST_ACCEPT_SCORE_NATIVE,
    BOOST_MAX_MATCHES_PER_TOPIC,
)
from shruti_chat.research.models import AttributionMatch, AttributionRef


log = get_logger(__name__)


# Lookup is parameterised so the same helper covers pinned + boost.
async def find_attributions(
    *,
    kind: Literal["pinned", "boost"],
    user_q_embedding: list[float],
    lang: str,
    embed_model: str,
    embed_dim: int,
    pool: Any,                           # asyncpg pool
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
    else:
        return []

    router = EmbeddingTableRouter(dim=embed_dim)

    # Stage 1 — NATIVE lang. MAX(score) per attribution (one attribution may
    # have N text variants; we want its best variant for THIS user query).
    native = await _query(pool, user_q_embedding, kind, embed_model, lang=lang, router=router)
    accepted_native = [m for m in native if m.score >= an]
    if accepted_native:
        return _take(accepted_native, mm, stage="native")

    # NATIVE below `an` but the top NATIVE score already clears the cross
    # threshold `ac` → accept as native without a second query. Checked
    # BEFORE the border gate: a score ≥ ac is a confident match, not a
    # borderline one, and must not be routed through (and possibly rejected
    # by) the judge. This avoids an unnecessary second SQL too.
    if native and native[0].score >= ac:
        accepted = [m for m in native if m.score >= ac]
        return _take(accepted, mm, stage="native")

    # Border-zone (pinned only) — the TRUE uncertain band `[bs, ac)`. Cosine
    # alone can't assert a curated attribution here; re-judge top1 with the
    # cross-encoder gate (LLM fallback inside). No confirmation ⇒ reject.
    if kind == "pinned" and bs is not None and native and native[0].score >= bs:
        top = native[0]
        if await _gate_border(
            native, top, lang,
            reranker=reranker, user_query=user_query, pool=pool,
            emb_table=router.attribution_table, embed_model=embed_model,
            llm=llm, model=confirm_model,
        ):
            return [_with_stage(top, "native")]
        # Explicit no — fall through, do NOT try cross stage (the closest
        # native-lang attribution was rejected; a worse cross-lang match is
        # not going to be better).
        return []

    cross = await _query(pool, user_q_embedding, kind, embed_model, lang=None, router=router)
    accepted_cross = [m for m in cross if m.score >= ac]
    if accepted_cross:
        return _take(accepted_cross, mm, stage="cross")

    # Cross-stage border-zone also goes through the cross-encoder gate.
    if kind == "pinned" and bs is not None and cross and cross[0].score >= bs:
        top = cross[0]
        if await _gate_border(
            cross, top, lang,
            reranker=reranker, user_query=user_query, pool=pool,
            emb_table=router.attribution_table, embed_model=embed_model,
            llm=llm, model=confirm_model,
        ):
            return [_with_stage(top, "cross")]

    return []


# ---- helpers --------------------------------------------------------------


async def _query(
    pool: Any,
    user_q_embedding: list[float],
    kind: str,
    embed_model: str,
    *,
    lang: str | None,
    router: EmbeddingTableRouter,
) -> list[AttributionMatch]:
    """One pgvector lookup. Returns top-10 candidates ordered by score desc.

    GROUP BY attribution.id with MAX(similarity) so an attribution with N
    variants reports its best variant for this query (we don't want it to
    appear N times in the result).

    Embeddings now live in the per-dim `attribution_emb_d{N}` table
    (migration 0030); `router` resolves the right table for the active
    deployment's `embed_dim`."""

    emb_table = router.attribution_table

    if lang is not None:
        sql = f"""
            SELECT a.id, a.refs::text AS refs_json,
                   MAX(1 - (e.embedding <=> $1::vector)) AS score
            FROM {emb_table} e
            JOIN attributions a ON a.id = e.attribution_id
            WHERE e.language = $2
              AND e.embed_model = $3
              AND a.kind = $4
            GROUP BY a.id, a.refs
            ORDER BY score DESC
            LIMIT 10
        """
        args = (user_q_embedding, lang, embed_model, kind)
    else:
        sql = f"""
            SELECT a.id, a.refs::text AS refs_json,
                   MAX(1 - (e.embedding <=> $1::vector)) AS score
            FROM {emb_table} e
            JOIN attributions a ON a.id = e.attribution_id
            WHERE e.embed_model = $2
              AND a.kind = $3
            GROUP BY a.id, a.refs
            ORDER BY score DESC
            LIMIT 10
        """
        args = (user_q_embedding, embed_model, kind)

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)

    out: list[AttributionMatch] = []
    for r in rows:
        refs_raw = json.loads(r["refs_json"]) if r["refs_json"] else []
        refs = [
            AttributionRef(ref_kind=ref.get("ref_kind", ""), target_id=ref.get("target_id", ""))
            for ref in refs_raw
            if ref.get("target_id")
        ]
        out.append(AttributionMatch(
            attribution_id=r["id"],
            kind=kind,                  # type: ignore[arg-type]
            refs=refs,
            score=float(r["score"]),
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
    pool: Any,
    emb_table: str,
    embed_model: str,
    llm: Any | None,
    model: str | None,
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
            reranker, pool, emb_table, embed_model, user_query, candidates, top, lang,
        )
        if decided is not None:
            return decided

    if llm is not None and user_query:
        texts = await _fetch_variant_texts(pool, emb_table, embed_model, top.attribution_id, lang)
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
    pool: Any,
    emb_table: str,
    embed_model: str,
    query: str,
    candidates: list[AttributionMatch],
    top: AttributionMatch,
    lang: str,
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
        for txt in await _fetch_variant_texts(pool, emb_table, embed_model, m.attribution_id, lang):
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

    accepted = best >= PINNED_RERANK_ACCEPT
    log.info(
        "attribution_rerank_gate",
        attribution_id=top.attribution_id,
        cosine=round(top.score, 3),
        rerank=round(best, 3),
        threshold=PINNED_RERANK_ACCEPT,
        accepted=accepted,
    )
    return accepted


async def _fetch_variant_texts(
    pool: Any, emb_table: str, embed_model: str, attribution_id: str, lang: str,
) -> list[str]:
    """The curated phrasings of one attribution. Prefer the user's language;
    if it has none in that lang, fall back to all languages so a cross-lingual
    border match still has text to rerank against."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT DISTINCT text FROM {emb_table} "
            "WHERE attribution_id = $1 AND embed_model = $2 AND language = $3",
            attribution_id, embed_model, lang,
        )
        if not rows:
            rows = await conn.fetch(
                f"SELECT DISTINCT text FROM {emb_table} "
                "WHERE attribution_id = $1 AND embed_model = $2",
                attribution_id, embed_model,
            )
    return [r["text"] for r in rows if r["text"]]


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
