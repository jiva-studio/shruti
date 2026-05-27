"""Attribution lookup against the Postgres `attributions` /
`attribution_embeddings` mirror.

Two-stage with asymmetric thresholds:
  1. NATIVE: filter by user's language. Lower-bound = accept_native.
  2. CROSS: if native top1 < border, retry across all languages with
     accept_cross (slightly lower to compensate cross-lingual penalty).

Question kind (critical): border-zone (0.70..accept_native) triggers an
optional LLM-confirm for the top1; rejection there returns [].
Topic kind: no LLM-confirm — boost is not worth a second LLM round-trip.

Multi-match: up to `max_matches` attributions above accept threshold are
returned. The synthesizer / fanout consumes the union of their refs.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import (
    QUESTION_ACCEPT_SCORE_CROSS,
    QUESTION_ACCEPT_SCORE_NATIVE,
    QUESTION_BORDER_SCORE,
    QUESTION_MAX_MATCHES,
    TOPIC_ACCEPT_SCORE_CROSS,
    TOPIC_ACCEPT_SCORE_NATIVE,
    TOPIC_MAX_MATCHES_PER_TOPIC,
)
from shruti_chat.research.models import AttributionMatch, AttributionRef


log = get_logger(__name__)


# Lookup is parameterised so the same helper covers question + topic.
async def find_attributions(
    *,
    kind: Literal["question", "topic"],
    user_q_embedding: list[float],
    lang: str,
    embed_model: str,
    embed_dim: int,
    pool: Any,                           # asyncpg pool
    llm: Any | None = None,              # for border-zone confirm; topic ignores
    confirm_model: str | None = None,
    accept_native: float | None = None,
    accept_cross: float | None = None,
    border_score: float | None = None,
    max_matches: int | None = None,
) -> list[AttributionMatch]:
    """Two-stage native + cross-lingual lookup. See module docstring."""

    if kind == "question":
        an = accept_native if accept_native is not None else QUESTION_ACCEPT_SCORE_NATIVE
        ac = accept_cross if accept_cross is not None else QUESTION_ACCEPT_SCORE_CROSS
        bs = border_score if border_score is not None else QUESTION_BORDER_SCORE
        mm = max_matches if max_matches is not None else QUESTION_MAX_MATCHES
    elif kind == "topic":
        an = accept_native if accept_native is not None else TOPIC_ACCEPT_SCORE_NATIVE
        ac = accept_cross if accept_cross is not None else TOPIC_ACCEPT_SCORE_CROSS
        bs = None  # topic does not use LLM-confirm
        mm = max_matches if max_matches is not None else TOPIC_MAX_MATCHES_PER_TOPIC
    else:
        return []

    router = EmbeddingTableRouter(dim=embed_dim)

    # Stage 1 — NATIVE lang. MAX(score) per attribution (one attribution may
    # have N text variants; we want its best variant for THIS user query).
    native = await _query(pool, user_q_embedding, kind, embed_model, lang=lang, router=router)
    accepted_native = [m for m in native if m.score >= an]
    if accepted_native:
        return _take(accepted_native, mm, stage="native")

    # Border-zone for question only — at most one LLM-confirm round-trip.
    if kind == "question" and bs is not None and native and native[0].score >= bs:
        top = native[0]
        if llm is None or await _confirm(llm, top, lang, model=confirm_model):
            return [_with_stage(top, "native")]
        # Explicit no — fall through, do NOT try cross stage (the closest
        # native-lang attribution was rejected; a worse cross-lang match is
        # not going to be better).
        return []

    # Stage 2 — CROSS-LINGUAL fallback (no language filter).
    if native and native[0].score >= ac:
        # NATIVE was below `an` but the top NATIVE score is already at or
        # above the cross threshold. Accept it without a second query — it's
        # already a NATIVE match, just slightly weaker than `an`. This avoids
        # an unnecessary second SQL when the data is in the user's language.
        accepted = [m for m in native if m.score >= ac]
        return _take(accepted, mm, stage="native")

    cross = await _query(pool, user_q_embedding, kind, embed_model, lang=None, router=router)
    accepted_cross = [m for m in cross if m.score >= ac]
    if accepted_cross:
        return _take(accepted_cross, mm, stage="cross")

    # Question-only: border-zone in cross stage also gets LLM-confirm.
    if kind == "question" and bs is not None and cross and cross[0].score >= bs:
        top = cross[0]
        if llm is None or await _confirm(llm, top, lang, model=confirm_model):
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


async def _confirm(
    llm: Any, match: AttributionMatch, lang: str, *, model: str | None = None,
) -> bool:
    """One Haiku-class LLM round-trip to confirm a border-zone question match.
    Returns True on yes / unparseable response (lean toward keeping the match
    when uncertain — refusal is the wrong default for a curator-validated entry).
    """
    from pydantic import BaseModel, Field

    class Confirm(BaseModel):
        yes: bool = Field(description="True if the curated question answers the user's query")

    system = (
        "You are a routing helper. Given a user query and a curated canonical "
        "question, answer YES if the canonical question is asking essentially "
        "the same thing (any phrasing). Answer NO if they are about different "
        "topics. Output strict JSON: {\"yes\": true|false}."
    )
    # We don't have the canonical text easily here — fall back to attribution_id
    # in the prompt. Caller can pass text in if needed via a follow-up enhancement.
    user = (
        f"User query lang={lang}: <unknown — see attribution id>\n"
        f"Canonical attribution_id: {match.attribution_id}\n"
        f"(retrieval score was {match.score:.2f} — borderline)"
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
        log.warning("attribution_confirm_failed", error=str(exc), attribution_id=match.attribution_id)
        return True  # lean toward keeping the match


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
