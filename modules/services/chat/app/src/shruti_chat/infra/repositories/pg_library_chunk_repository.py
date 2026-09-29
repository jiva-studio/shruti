"""Postgres reads of the library lanes of `chunks`: verses, purports, prose, letters, media.

Library chunks are reference-only — the body a card shows is resolved from
`library.db` at serve time — so every read here builds a `LibraryChunk` from
the shared chunk columns.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from shruti_chat.domain.entities import LibraryChunk, ScoredLibraryChunk
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter

# Chunk kinds may be inlined as SQL literals (to match the per-kind partial
# HNSW indexes from migration 0035, whose predicates the planner can only
# match against a constant — not a bound array param). Validate against this
# fixed internal vocabulary before string-building as defence-in-depth.
ALLOWED_KINDS = frozenset(
    {
        "track_transcript",
        "user_track",
        "verse",
        "commentary",
        "prose_chapter",
        "letter",
        "media",
        "title",
    }
)


def _library_chunk_from_row(r: Any) -> LibraryChunk:
    """Build a reference-only `LibraryChunk` from a chunks row.

    Media chunks are reference-only just like verses: their url / type /
    speaker / provenance are NOT stored on the chunk — they are resolved
    at serve time via fetch_media(item_id). So this builder reads only the
    shared chunk columns, same for every kind.
    """
    return LibraryChunk(
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


class PgLibraryChunkRepository:
    def __init__(
        self, *, pool: asyncpg.Pool, embed_model: str, router: EmbeddingTableRouter,
    ) -> None:
        self._pool = pool
        self._embed_model = embed_model
        self._router = router

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
        bad = [k for k in kinds if k not in ALLOWED_KINDS]
        if bad:
            raise ValueError(f"unknown chunk kind(s): {bad}")
        # Inline kinds as constant literals on the EMBEDDING table so the
        # matching per-kind partial HNSW index (migration 0035) is used.
        # A bound `kind = ANY($2)` array can't be matched to a partial
        # index predicate at plan time, leaving a full-index deep scan +
        # post-filter (a multi-second spike). lang stays a
        # post-filter column (also on `e`) — out of the index predicate so
        # the same index serves the lang-less fallback.
        kind_literals = ", ".join(f"'{k}'" for k in kinds)
        where: list[str] = [
            "c.embed_model = $1",
            f"e.kind IN ({kind_literals})",
        ]
        params: list[Any] = [self._embed_model]
        if lang:
            where.append(f"e.lang = ${len(params) + 1}")
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
                chunk=_library_chunk_from_row(r),
                score=float(r["score"]),
            )
            for r in rows
        ]

    async def search_chunks_lexical(
        self,
        query_text: str,
        query_embedding: list[float],
        *,
        kinds: list[str],
        lang: str | None = None,
        source_id: str | None = None,
        author_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        top_k: int = 24,
        trgm_min_sim: float = 0.3,
    ) -> list[ScoredLibraryChunk]:
        """Lexical (full-text + trigram) recall lane for hybrid retrieval.

        Matches `text` via tsvector (`russian` morphology OR `simple` for
        Sanskrit transliteration) AND the canonical address via pg_trgm —
        exactly the classes dense ANN misses. Results are ordered by lexical
        relevance (informational — the caller does not fuse ranks; it forces
        these rows into the rerank pool instead), and each carries its TRUE
        cosine vs `query_embedding` (INNER JOIN to the embedding table) so the
        downstream coverage/max_score gates stay honest.
        Rows lacking an embedding for the active model (a rare indexing
        inconsistency) are dropped rather than surfaced unscored.

        Not cached: lexical queries have no embedding-keyed cache contract, and
        they're cheap GIN lookups.
        """
        if not kinds or not query_text.strip():
            return []
        emb_table = self._router.chunk_table
        # $1 embed_model, $2 kinds, $3 query_text; optional filters appended;
        # then embedding and limit appended last.
        where: list[str] = [
            "c.embed_model = $1",
            "c.kind = ANY($2::text[])",
            # FTS (either config) OR trigram address match. The OR lets the
            # planner BitmapOr the three GIN indexes from migration 0032.
            (
                "(to_tsvector('russian', c.text) @@ websearch_to_tsquery('russian', $3)"
                " OR to_tsvector('simple', c.text) @@ websearch_to_tsquery('simple', $3)"
                " OR (c.source_id IS NOT NULL AND"
                "     (coalesce(c.addr_label,'') || ' ' || coalesce(c.source_id,'')"
                "      || ' ' || coalesce(c.tokens,'')) % $3))"
            ),
        ]
        params: list[Any] = [self._embed_model, kinds, query_text]
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
        params.append(query_embedding)
        emb_pos = len(params)
        params.append(top_k)
        limit_pos = len(params)
        sql = f"""
          SELECT c.item_id, c.kind, c.source_id, c.tokens, c.author_id, c.doc_date,
                 c.lang, c.segment_index, c.text, c.addr_label,
                 1 - (e.embedding <=> ${emb_pos}::vector) AS score,
                 GREATEST(
                     ts_rank(to_tsvector('russian', c.text), websearch_to_tsquery('russian', $3)),
                     ts_rank(to_tsvector('simple',  c.text), websearch_to_tsquery('simple',  $3)),
                     CASE WHEN c.source_id IS NOT NULL
                          THEN similarity(
                              coalesce(c.addr_label,'') || ' ' || coalesce(c.source_id,'')
                              || ' ' || coalesce(c.tokens,''), $3)
                          ELSE 0 END
                 ) AS lex_rank
          FROM chunks c
          JOIN {emb_table} e ON e.chunk_id = c.id
          WHERE {' AND '.join(where)}
          ORDER BY lex_rank DESC
          LIMIT ${limit_pos}
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # pg_trgm `%` operator honours this threshold and uses the
                # trgm GIN index from 0032. SET doesn't take bind params, so
                # use set_config(..., is_local=true) — scoped to this txn.
                await conn.execute(
                    "SELECT set_config('pg_trgm.similarity_threshold', $1, true)",
                    str(trgm_min_sim),
                )
                rows = await conn.fetch(sql, *params)
        return [
            ScoredLibraryChunk(
                chunk=_library_chunk_from_row(r),
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
