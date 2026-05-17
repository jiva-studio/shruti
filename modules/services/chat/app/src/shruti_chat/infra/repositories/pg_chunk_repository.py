"""Postgres-backed `ChunkRepository`.

Reads from the `chunks` table via an injected asyncpg pool. The
`embed_model` name is injected too — the adapter applies it as a SQL
filter so callers don't need to know which embedder produced the
vector. Composition root in `main.py:lifespan` builds the pool and the
embedder, then wires them in.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from shruti_chat.domain.entities import Chunk, ScoredChunk


class PgChunkRepository:
    def __init__(self, *, pool: asyncpg.Pool, embed_model: str) -> None:
        self._pool = pool
        self._embed_model = embed_model

    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        where = ["embed_model = $1"]
        params: list[Any] = [self._embed_model]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        if eligible_track_ids is not None:
            where.append(f"track_id = ANY(${len(params) + 1}::text[])")
            params.append(eligible_track_ids)
        if excluded_track_ids:
            where.append(f"track_id <> ALL(${len(params) + 1}::text[])")
            params.append(excluded_track_ids)
        params.append(embedding)
        params.append(top_k)
        # When excluding tracks (recommend / similar), de-dupe to one
        # chunk per track via DISTINCT ON; otherwise return raw top-k.
        select_clause = (
            "DISTINCT ON (track_id) track_id, lang, start_ms, end_ms, text, reference_source_id"
            if excluded_track_ids
            else "track_id, lang, start_ms, end_ms, text, reference_source_id"
        )
        order_clause = (
            f"ORDER BY track_id, embedding <=> ${len(params) - 1}::vector"
            if excluded_track_ids
            else f"ORDER BY embedding <=> ${len(params) - 1}::vector"
        )
        sql = f"""
          SELECT {select_clause},
                 1 - (embedding <=> ${len(params) - 1}::vector) AS score
          FROM chunks
          WHERE {' AND '.join(where)}
          {order_clause}
          LIMIT ${len(params)}
        """
        pool = self._pool
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [
            ScoredChunk(
                chunk=Chunk(
                    track_id=r["track_id"],
                    lang=r["lang"],
                    start_ms=r["start_ms"],
                    end_ms=r["end_ms"],
                    text=r["text"],
                    reference_source_id=r["reference_source_id"],
                ),
                score=float(r["score"]),
            )
            for r in rows
        ]

    async def get_window(
        self,
        track_id: str,
        around_ms: int,
        *,
        window_ms: int,
        lang: str | None,
        max_chunks: int,
    ) -> list[Chunk]:
        lo = max(0, int(around_ms) - window_ms)
        hi = int(around_ms) + window_ms
        where = ["track_id = $1", "end_ms >= $2", "start_ms <= $3"]
        params: list[Any] = [track_id, lo, hi]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        params.append(max_chunks)
        sql = f"""
          SELECT track_id, lang, start_ms, end_ms, text, reference_source_id
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY start_ms
          LIMIT ${len(params)}
        """
        pool = self._pool
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [
            Chunk(
                track_id=r["track_id"],
                lang=r["lang"],
                start_ms=r["start_ms"],
                end_ms=r["end_ms"],
                text=r["text"],
                reference_source_id=r["reference_source_id"],
            )
            for r in rows
        ]

    async def get_anchor_texts(
        self,
        track_id: str,
        *,
        start_ms: int | None,
        end_ms: int | None,
        lang: str | None,
        limit: int,
    ) -> list[str]:
        where: list[str] = ["track_id = $1"]
        params: list[Any] = [track_id]
        if start_ms is not None and end_ms is not None:
            where.append(f"end_ms >= ${len(params) + 1}")
            params.append(int(start_ms))
            where.append(f"start_ms <= ${len(params) + 1}")
            params.append(int(end_ms))
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        params.append(limit)
        sql = f"""
          SELECT text FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY start_ms
          LIMIT ${len(params)}
        """
        pool = self._pool
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [r["text"] for r in rows]

    async def get_first_chunk_embeddings(
        self,
        track_ids: list[str],
        *,
        lang: str | None,
    ) -> list[list[float]]:
        if not track_ids:
            return []
        where = ["embed_model = $1", "track_id = ANY($2::text[])"]
        params: list[Any] = [self._embed_model, track_ids]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT DISTINCT ON (track_id) track_id, embedding
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY track_id, start_ms
        """
        pool = self._pool
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        # pgvector's asyncpg codec gives us list[float] / numpy directly;
        # cast to list for predictability.
        return [list(r["embedding"]) for r in rows]
