"""Postgres reads of curated attributions: the matches, their texts and notes.

The `attributions` mirror and its per-dim embedding table live in the same
Postgres as `chunks`; the active `embed_model` and the `EmbeddingTableRouter`
name the `attribution_emb_d{dim}` table to read.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg

from shruti_chat.domain.entities import AttributionCandidate
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter


class PgAttributionRepository:
    def __init__(
        self, *, pool: asyncpg.Pool, embed_model: str, router: EmbeddingTableRouter,
    ) -> None:
        self._pool = pool
        self._embed_model = embed_model
        self._router = router

    async def find_attributions(
        self,
        embedding: list[float],
        *,
        kind: str,
        lang: str | None,
    ) -> list[AttributionCandidate]:
        emb_table = self._router.attribution_table
        # GROUP BY attribution id with MAX(similarity) so an attribution with
        # N text variants reports its BEST variant for this query instead of
        # appearing N times.
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
            args: tuple[Any, ...] = (embedding, lang, self._embed_model, kind)
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
            args = (embedding, self._embed_model, kind)

        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *args)

        out: list[AttributionCandidate] = []
        for r in rows:
            refs = json.loads(r["refs_json"]) if r["refs_json"] else []
            out.append(AttributionCandidate(
                attribution_id=r["id"],
                refs=[ref for ref in refs if isinstance(ref, dict)],
                score=float(r["score"]),
            ))
        return out

    async def attribution_texts(
        self, attribution_id: str, *, lang: str | None,
    ) -> list[str]:
        emb_table = self._router.attribution_table
        async with self._pool.acquire() as conn:
            rows = []
            if lang is not None:
                rows = await conn.fetch(
                    f"SELECT DISTINCT text FROM {emb_table} "
                    "WHERE attribution_id = $1 AND embed_model = $2 AND language = $3",
                    attribution_id, self._embed_model, lang,
                )
            if not rows:
                rows = await conn.fetch(
                    f"SELECT DISTINCT text FROM {emb_table} "
                    "WHERE attribution_id = $1 AND embed_model = $2",
                    attribution_id, self._embed_model,
                )
        return [r["text"] for r in rows if r["text"]]

    async def fetch_attribution_note(
        self, attribution_id: str, *, lang: str,
    ) -> str | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT note FROM attribution_notes "
                "WHERE attribution_id = $1 AND language = $2",
                attribution_id, lang,
            )
            if row is None:
                row = await conn.fetchrow(
                    "SELECT note FROM attribution_notes WHERE attribution_id = $1 "
                    "ORDER BY (language = 'en') DESC, language LIMIT 1",
                    attribution_id,
                )
        return row["note"] if row else None
