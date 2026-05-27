"""Postgres-backed `ChunkRepository`.

Reads from the `chunks` table via an injected asyncpg pool. The
`embed_model` name is injected too — the adapter applies it as a SQL
filter so callers don't need to know which embedder produced the
vector. Composition root in `main.py:lifespan` builds the pool and the
embedder, then wires them in.

The optional `kv_cache` memoises ANN searches by `(embedding, filters,
top_k)`. A hit short-circuits the pgvector roundtrip entirely; a miss
falls through to the live query and writes the result back. The cache
is L1+L2 (process + Redis), versioned on `embed_model` so a reindex
silently invalidates everything.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import asyncpg

from lectorium_chat.domain.entities import Chunk, LibraryChunk, ScoredChunk, ScoredLibraryChunk
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter


def _embedding_digest(embedding: list[float]) -> str:
    """blake2b-12 over the float bytes (rounded to 7 sig figs to absorb
    trivial float jitter from re-quantised embeddings). Two embeddings
    that agree to 7 sig figs share a cache key."""
    rounded = [round(x, 7) for x in embedding]
    payload = json.dumps(rounded, separators=(",", ":"))
    return hashlib.blake2b(payload.encode("utf-8"), digest_size=12).hexdigest()


class PgChunkRepository:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        embed_model: str,
        router: EmbeddingTableRouter,
        kv_cache: Any | None = None,
    ) -> None:
        self._pool = pool
        self._embed_model = embed_model
        self._router = router
        self._cache = kv_cache

    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        if self._cache is None:
            return await self._search_by_embedding_raw(
                embedding,
                eligible_track_ids=eligible_track_ids,
                excluded_track_ids=excluded_track_ids,
                lang=lang,
                top_k=top_k,
            )
        from lectorium_chat.application.cache_helpers import TTL_6H, make_key
        key = make_key(
            "pg_chunk_search",
            {
                "emb": _embedding_digest(embedding),
                "eligible": sorted(eligible_track_ids) if eligible_track_ids else None,
                "excluded": sorted(excluded_track_ids) if excluded_track_ids else None,
                "lang": lang,
                "top_k": top_k,
            },
        )
        cached = await self._cache.get(key)
        if cached is not None:
            try:
                rows = json.loads(cached)
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
            except (UnicodeDecodeError, json.JSONDecodeError, KeyError):
                pass
        result = await self._search_by_embedding_raw(
            embedding,
            eligible_track_ids=eligible_track_ids,
            excluded_track_ids=excluded_track_ids,
            lang=lang,
            top_k=top_k,
        )
        try:
            payload = json.dumps(
                [
                    {
                        "track_id": r.chunk.track_id,
                        "lang": r.chunk.lang,
                        "start_ms": r.chunk.start_ms,
                        "end_ms": r.chunk.end_ms,
                        "text": r.chunk.text,
                        "reference_source_id": r.chunk.reference_source_id,
                        "score": r.score,
                    }
                    for r in result
                ],
                ensure_ascii=False,
            ).encode("utf-8")
            # ANN result payloads stay well under 32 KB for top_k≤16;
            # cap defensively to keep Redis usage predictable.
            if len(payload) <= 32 * 1024:
                await self._cache.set(key, payload, ttl_s=TTL_6H)
        except Exception:  # noqa: BLE001 — caching is best-effort
            pass
        return result

    async def _search_by_embedding_raw(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        # `kind='track_transcript'` keeps library rows out of lecture search.
        # Embedding column now lives in `chunk_embeddings_d{dim}` (migration
        # 0030); join through chunk_id.
        emb_table = self._router.chunk_table
        where = ["c.embed_model = $1", "c.kind = 'track_transcript'"]
        params: list[Any] = [self._embed_model]
        if lang:
            where.append(f"c.lang = ${len(params) + 1}")
            params.append(lang)
        if eligible_track_ids is not None:
            where.append(f"c.track_id = ANY(${len(params) + 1}::text[])")
            params.append(eligible_track_ids)
        if excluded_track_ids:
            where.append(f"c.track_id <> ALL(${len(params) + 1}::text[])")
            params.append(excluded_track_ids)
        params.append(embedding)
        params.append(top_k)
        # When excluding tracks (recommend / similar), de-dupe to one
        # chunk per track via DISTINCT ON; otherwise return raw top-k.
        select_clause = (
            "DISTINCT ON (c.track_id) c.track_id, c.lang, c.start_ms, c.end_ms, "
            "c.text, c.reference_source_id"
            if excluded_track_ids
            else "c.track_id, c.lang, c.start_ms, c.end_ms, c.text, "
                 "c.reference_source_id"
        )
        order_clause = (
            f"ORDER BY c.track_id, e.embedding <=> ${len(params) - 1}::vector"
            if excluded_track_ids
            else f"ORDER BY e.embedding <=> ${len(params) - 1}::vector"
        )
        sql = f"""
          SELECT {select_clause},
                 1 - (e.embedding <=> ${len(params) - 1}::vector) AS score
          FROM chunks c
          JOIN {emb_table} e ON e.chunk_id = c.id
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
                # Default ef_search=40 starves the iterative scan when
                # WHERE filters prune the top candidates. 80 doubles the
                # candidate pool at negligible extra cost once the HNSW
                # index sits in shared_buffers (see compose tuning).
                await conn.execute("SET LOCAL hnsw.ef_search = 80")
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
        if self._cache is None:
            return await self._get_window_raw(
                track_id, around_ms, window_ms=window_ms, lang=lang, max_chunks=max_chunks,
            )
        from lectorium_chat.application.cache_helpers import TTL_24H, make_key
        key = make_key(
            "pg_window",
            {
                "track_id": track_id,
                "around_ms": int(around_ms),
                "window_ms": int(window_ms),
                "lang": lang,
                "max_chunks": int(max_chunks),
            },
        )
        cached = await self._cache.get(key)
        if cached is not None:
            try:
                rows = json.loads(cached)
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
            except (UnicodeDecodeError, json.JSONDecodeError, KeyError):
                pass
        result = await self._get_window_raw(
            track_id, around_ms, window_ms=window_ms, lang=lang, max_chunks=max_chunks,
        )
        try:
            payload = json.dumps(
                [
                    {
                        "track_id": c.track_id,
                        "lang": c.lang,
                        "start_ms": c.start_ms,
                        "end_ms": c.end_ms,
                        "text": c.text,
                        "reference_source_id": c.reference_source_id,
                    }
                    for c in result
                ],
                ensure_ascii=False,
            ).encode("utf-8")
            if len(payload) <= 64 * 1024:
                await self._cache.set(key, payload, ttl_s=TTL_24H)
        except Exception:  # noqa: BLE001
            pass
        return result

    async def _get_window_raw(
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
        emb_table = self._router.chunk_table
        where: list[str] = [
            "c.embed_model = $1",
            f"c.kind = ANY($2::text[])",
        ]
        params: list[Any] = [self._embed_model, kinds]
        if lang:
            where.append(f"c.lang = ${len(params) + 1}")
            params.append(lang)
        if source_id:
            where.append(f"c.source_id = ${len(params) + 1}")
            params.append(source_id)
        if author_id:
            where.append(f"c.author_id = ${len(params) + 1}")
            params.append(author_id)
        if date_from:
            where.append(f"c.doc_date >= ${len(params) + 1}")
            params.append(date_from)
        if date_to:
            where.append(f"c.doc_date <= ${len(params) + 1}")
            params.append(date_to)
        params.append(embedding)
        params.append(top_k)
        sql = f"""
          SELECT c.item_id, c.kind, c.source_id, c.tokens, c.author_id, c.doc_date,
                 c.lang, c.segment_index, c.text, c.addr_label,
                 1 - (e.embedding <=> ${len(params) - 1}::vector) AS score
          FROM chunks c
          JOIN {emb_table} e ON e.chunk_id = c.id
          WHERE {' AND '.join(where)}
          ORDER BY e.embedding <=> ${len(params) - 1}::vector
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
                # Default ef_search=40 starves the iterative scan when
                # WHERE filters prune the top candidates. 80 doubles the
                # candidate pool at negligible extra cost once the HNSW
                # index sits in shared_buffers (see compose tuning).
                await conn.execute("SET LOCAL hnsw.ef_search = 80")
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

    async def get_chunks_by_verse(
        self,
        *,
        source_id: str,
        tokens: str,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        if not kinds:
            return []
        where: list[str] = [
            "kind = ANY($1::text[])",
            "embed_model = $2",
            "source_id = $3",
            "tokens = $4",
        ]
        params: list[Any] = [kinds, self._embed_model, source_id, tokens]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT item_id, kind, source_id, tokens, author_id, doc_date,
                 lang, segment_index, text, addr_label
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY kind, author_id NULLS LAST, segment_index NULLS FIRST
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
        emb_table = self._router.chunk_table
        where = ["c.embed_model = $1", "c.track_id = ANY($2::text[])"]
        params: list[Any] = [self._embed_model, track_ids]
        if lang:
            where.append(f"c.lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT DISTINCT ON (c.track_id) c.track_id, e.embedding
          FROM chunks c
          JOIN {emb_table} e ON e.chunk_id = c.id
          WHERE {' AND '.join(where)}
          ORDER BY c.track_id, c.start_ms
        """
        pool = self._pool
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        # pgvector's asyncpg codec gives us list[float] / numpy directly;
        # cast to list for predictability.
        return [list(r["embedding"]) for r in rows]
