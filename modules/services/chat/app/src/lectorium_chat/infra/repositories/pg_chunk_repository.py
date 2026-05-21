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

from lectorium_chat.domain.entities import Chunk, LibraryChunk, ScoredChunk, ScoredLibraryChunk


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
        # `kind='track_transcript'` keeps library rows out of lecture search.
        where = ["embed_model = $1", "kind = 'track_transcript'"]
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
            async with conn.transaction():
                # SET LOCAL keeps the param scoped to this transaction.
                # See _init_connection in db/client.py for the rationale —
                # filtered HNSW search returns 0 rows without it.
                await conn.execute(
                    "SET LOCAL hnsw.iterative_scan = relaxed_order"
                )
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

    async def search_library_by_embedding(
        self,
        embedding: list[float],
        *,
        kinds: list[str],
        source_id: str | None = None,
        author_id: str | None = None,
        lang: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        top_k: int = 8,
    ) -> list[ScoredLibraryChunk]:
        if not kinds:
            return []
        where: list[str] = [
            "embed_model = $1",
            f"kind = ANY($2::text[])",
        ]
        params: list[Any] = [self._embed_model, kinds]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        if source_id:
            where.append(f"source_id = ${len(params) + 1}")
            params.append(source_id)
        if author_id:
            where.append(f"author_id = ${len(params) + 1}")
            params.append(author_id)
        if date_from:
            where.append(f"doc_date >= ${len(params) + 1}")
            params.append(date_from)
        if date_to:
            where.append(f"doc_date <= ${len(params) + 1}")
            params.append(date_to)
        params.append(embedding)
        params.append(top_k)
        sql = f"""
          SELECT item_id, kind, source_id, tokens, author_id, doc_date,
                 lang, segment_index, text, addr_label,
                 1 - (embedding <=> ${len(params) - 1}::vector) AS score
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY embedding <=> ${len(params) - 1}::vector
          LIMIT ${len(params)}
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # SET LOCAL is scoped to this transaction so it doesn't
                # bleed into other queries on the same conn. pgvector
                # HNSW + WHERE filters need iterative_scan to find rows
                # past the ef_search candidates; without it filtered
                # queries return 0 rows.
                await conn.execute(
                    "SET LOCAL hnsw.iterative_scan = relaxed_order"
                )
                rows = await conn.fetch(sql, *params)
        return [
            ScoredLibraryChunk(
                chunk=LibraryChunk(
                    item_id=r["item_id"],
                    item_kind=r["kind"],
                    source_id=r["source_id"],
                    tokens=r["tokens"],
                    author_id=r["author_id"],
                    doc_date=r["doc_date"],
                    lang=r["lang"],
                    segment_index=r["segment_index"],
                    text=r["text"],
                    addr_label=r["addr_label"],
                ),
                score=float(r["score"]),
            )
            for r in rows
        ]

    async def get_chunks_by_addr_label(
        self,
        addr_label: str,
        *,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        if not kinds:
            return []
        where: list[str] = [
            "kind = ANY($1::text[])",
            "embed_model = $2",
            "addr_label = $3",
        ]
        params: list[Any] = [kinds, self._embed_model, addr_label]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT item_id, kind, source_id, tokens, author_id, doc_date,
                 lang, segment_index, text, addr_label
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY segment_index NULLS FIRST
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [
            LibraryChunk(
                item_id=r["item_id"],
                item_kind=r["kind"],
                source_id=r["source_id"],
                tokens=r["tokens"],
                author_id=r["author_id"],
                doc_date=r["doc_date"],
                lang=r["lang"],
                segment_index=r["segment_index"],
                text=r["text"],
                addr_label=r["addr_label"],
            )
            for r in rows
        ]

    async def get_chunks_by_target(
        self,
        *,
        ref_kind: str,
        target_id: str,
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        """ref_kind='verse'    → chunks.kind='verse'
           ref_kind='document' → chunks.kind IN ('commentary','prose_chapter','letter')

        chunks.item_id IS the opaque library entity ID (verse.id /
        library_document.id) — copied verbatim by chunker.py:175,240 — so
        this is a JOIN-by-equality with no parsing.
        """
        if ref_kind == "verse":
            kinds = ["verse"]
        elif ref_kind == "document":
            kinds = ["commentary", "prose_chapter", "letter"]
        else:
            return []

        where: list[str] = [
            "kind = ANY($1::text[])",
            "embed_model = $2",
            "item_id = $3",
        ]
        params: list[Any] = [kinds, self._embed_model, target_id]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT item_id, kind, source_id, tokens, author_id, doc_date,
                 lang, segment_index, text, addr_label
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY segment_index NULLS FIRST
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [
            LibraryChunk(
                item_id=r["item_id"],
                item_kind=r["kind"],
                source_id=r["source_id"],
                tokens=r["tokens"],
                author_id=r["author_id"],
                doc_date=r["doc_date"],
                lang=r["lang"],
                segment_index=r["segment_index"],
                text=r["text"],
                addr_label=r["addr_label"],
            )
            for r in rows
        ]

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
