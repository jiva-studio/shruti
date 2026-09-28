"""Postgres-backed `ChunkRepository`.

Reads from the `chunks` table via an injected asyncpg pool. The
`embed_model` name is injected too — the adapter applies it as a SQL
filter so callers don't need to know which embedder produced the
vector. Composition root in `main.py:lifespan` builds the pool and the
embedder, then wires them in.

The lecture lanes are read here. The library lanes
(`pg_library_chunk_repository`), curated attributions
(`pg_attribution_repository`) and the private lane's owner records
(`pg_private_owner_repository`) have their own repositories, which
`PgChunkRepository` fronts so the `ChunkRepository` port stays one object.

The optional `memo_cache` memoises ANN searches by `(embedding, filters,
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

from shruti_chat.domain.ports.memo_cache import MemoCache
from shruti_chat.domain.entities import (
    AttributionCandidate,
    Chunk,
    LibraryChunk,
    ScoredChunk,
    ScoredLibraryChunk,
)
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.infra.repositories.pg_attribution_repository import PgAttributionRepository
from shruti_chat.infra.repositories.pg_library_chunk_repository import (
    ALLOWED_KINDS,
    PgLibraryChunkRepository,
)
from shruti_chat.infra.repositories.pg_private_owner_repository import (
    PgPrivateOwnerRepository,
)
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

# Languages with a per-(kind,lang) composite partial HNSW index on the
# lecture lane (migration 0036). A lecture query in one of these langs
# inlines `e.lang = '<lang>'` as a constant so the planner matches the
# composite index; any other lang (or lang-less) uses the kind-only
# `_hnsw_lec` partial. Keep in sync with the `langs` array in 0036.
_LECTURE_PARTIAL_LANGS = frozenset({"en", "ru"})

# Over-fetch factor for the de-duplicated (one-chunk-per-track) search. The
# candidate scan stays ordered by distance so the HNSW index drives it; this
# many times `top_k` rows is enough to still hold `top_k` distinct tracks
# after collapsing, without scanning the whole lane.
_DEDUP_CANDIDATE_FACTOR = 10


def _embedding_digest(embedding: list[float]) -> str:
    """blake2b-12 over the float bytes (rounded to 7 sig figs to absorb
    trivial float jitter from re-quantised embeddings). Two embeddings
    that agree to 7 sig figs share a cache key."""
    rounded = [round(x, 7) for x in embedding]
    payload = json.dumps(rounded, separators=(",", ":"))
    return hashlib.blake2b(payload.encode("utf-8"), digest_size=12).hexdigest()


class PgChunkRepository:
    """The `ChunkRepository` adapter: the lecture lanes are read here; the
    library lanes, curated attributions and the private lane's owner records
    are read by their own repositories, which this one fronts."""

    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        embed_model: str,
        router: EmbeddingTableRouter,
        memo_cache: MemoCache | None = None,
    ) -> None:
        self._pool = pool
        self._embed_model = embed_model
        self._router = router
        self._cache = memo_cache
        self._owners = PgPrivateOwnerRepository(pool=pool)
        self._library = PgLibraryChunkRepository(
            pool=pool, embed_model=embed_model, router=router,
        )
        self._attributions = PgAttributionRepository(
            pool=pool, embed_model=embed_model, router=router,
        )

    async def distinct_langs(self) -> list[str]:
        async def _raw() -> list[str]:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT DISTINCT lang FROM chunks WHERE lang IS NOT NULL"
                )
            return sorted(r["lang"] for r in rows if r["lang"])

        if self._cache is None:
            return await _raw()
        from shruti_chat.domain.cache import TTL_24H

        result = await self._cache.cached_json(
            ns="corpus_langs",
            key_parts={"v": 1},
            ttl_s=TTL_24H,
            factory=_raw,
        )
        # cached_json round-trips through JSON; the value is a list of str.
        return list(result) if isinstance(result, list) else await _raw()

    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
        kind: str = "track_transcript",
    ) -> list[ScoredChunk]:
        # `kind` selects the lane: 'track_transcript' is the public corpus,
        # 'user_track' is the private per-user lane (migration 0043). The two
        # never overlap — each is a distinct partial HNSW predicate — so the
        # default corpus search can never return a user_track row.
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unknown chunk kind: {kind}")
        if self._cache is None:
            return await self._search_by_embedding_raw(
                embedding,
                eligible_track_ids=eligible_track_ids,
                excluded_track_ids=excluded_track_ids,
                lang=lang,
                top_k=top_k,
                kind=kind,
            )
        from shruti_chat.domain.cache import TTL_6H
        key = self._cache.make_key(
            "pg_chunk_search",
            {
                "emb": _embedding_digest(embedding),
                "eligible": sorted(eligible_track_ids) if eligible_track_ids else None,
                "excluded": sorted(excluded_track_ids) if excluded_track_ids else None,
                "lang": lang,
                "top_k": top_k,
                "kind": kind,
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
            kind=kind,
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
        kind: str = "track_transcript",
    ) -> list[ScoredChunk]:
        # `kind` keeps the lanes apart: 'track_transcript' is the public
        # corpus, 'user_track' the private per-user lane — library rows
        # (verse/commentary/…) never appear either way. Embedding column
        # lives in `chunk_embeddings_d{dim}` (migration 0030); join through
        # chunk_id. The kind/lang filters target the EMBEDDING table
        # (migration 0035 denormalized them there) so the matching partial
        # HNSW index is used — a filter on `c` would only post-filter after
        # a full-index deep scan. `kind` is validated against the fixed
        # internal vocabulary before it's inlined (defence-in-depth), same
        # as the library search — a bound param can't match a partial-index
        # predicate at plan time.
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unknown chunk kind: {kind}")
        emb_table = self._router.chunk_table
        where = ["c.embed_model = $1", f"e.kind = '{kind}'"]
        params: list[Any] = [self._embed_model]
        if lang:
            # The per-(kind,lang) composite partial HNSW index (migration
            # 0036) exists ONLY for the public lecture lane; inlining lang as
            # a constant matches it. The private lane has a kind-only partial
            # (0043), so its lang stays a bound post-filter param.
            if kind == "track_transcript" and lang in _LECTURE_PARTIAL_LANGS:
                # Safe: only the fixed-set values in _LECTURE_PARTIAL_LANGS
                # ever reach this branch. Other langs fall through to the
                # bound param.
                where.append(f"e.lang = '{lang}'")
            else:
                where.append(f"e.lang = ${len(params) + 1}")
                params.append(lang)
        if eligible_track_ids is not None:
            where.append(f"c.track_id = ANY(${len(params) + 1}::text[])")
            params.append(eligible_track_ids)
        if excluded_track_ids:
            where.append(f"c.track_id <> ALL(${len(params) + 1}::text[])")
            params.append(excluded_track_ids)
        params.append(embedding)
        emb_idx = len(params)
        params.append(top_k)
        top_k_idx = len(params)
        cols = (
            "c.track_id, c.lang, c.start_ms, c.end_ms, c.text, "
            "c.reference_source_id"
        )
        if excluded_track_ids:
            # Recommend / similar: one chunk per track. DISTINCT ON must be
            # ordered by its own key, so it cannot also rank by distance —
            # doing both at one level would make LIMIT keep the
            # lexicographically smallest track_ids rather than the nearest,
            # and lose the index ordering too. Collapse inside a distance-ordered bounded scan,
            # then rank and cut outside it.
            params.append(top_k * _DEDUP_CANDIDATE_FACTOR)
            sql = f"""
              SELECT t.track_id, t.lang, t.start_ms, t.end_ms, t.text,
                     t.reference_source_id, 1 - t.dist AS score
              FROM (
                SELECT DISTINCT ON (cand.track_id)
                       cand.track_id, cand.lang, cand.start_ms, cand.end_ms,
                       cand.text, cand.reference_source_id, cand.dist
                FROM (
                  SELECT {cols},
                         e.embedding <=> ${emb_idx}::vector AS dist
                  FROM chunks c
                  JOIN {emb_table} e ON e.chunk_id = c.id
                  WHERE {' AND '.join(where)}
                  ORDER BY e.embedding <=> ${emb_idx}::vector
                  LIMIT ${len(params)}
                ) cand
                ORDER BY cand.track_id, cand.dist
              ) t
              ORDER BY t.dist
              LIMIT ${top_k_idx}
            """
        else:
            sql = f"""
              SELECT {cols},
                     1 - (e.embedding <=> ${emb_idx}::vector) AS score
              FROM chunks c
              JOIN {emb_table} e ON e.chunk_id = c.id
              WHERE {' AND '.join(where)}
              ORDER BY e.embedding <=> ${emb_idx}::vector
              LIMIT ${top_k_idx}
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
        from shruti_chat.domain.cache import TTL_24H
        key = self._cache.make_key(
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

    async def get_chunk_text_exact(
        self,
        track_id: str,
        *,
        start_ms: int,
        end_ms: int,
        lang: str | None,
    ) -> str | None:
        where = [
            "track_id = $1",
            "start_ms = $2",
            "end_ms = $3",
            "kind = 'track_transcript'",
        ]
        params: list[Any] = [track_id, int(start_ms), int(end_ms)]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"SELECT text FROM chunks WHERE {' AND '.join(where)} LIMIT 1"
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(sql, *params)
        return row["text"] if row is not None else None

    async def get_chunks_by_track_fragment(
        self,
        *,
        target_id: str,
        lang: str | None = None,
    ) -> list[Chunk]:
        """Resolve a ref_kind='track' target into transcript chunks.

        target_id is "<track_id>@<start_ms>-<end_ms>" — the address a curator
        attributes via shruti-mcp. Returns the track's transcript chunks
        overlapping [start_ms, end_ms] (same overlap predicate as
        _get_window_raw). Whole-lecture refs (a bare track_id, no "@range")
        are NOT supported — attribution always points at a specific passage —
        so a target_id without a parseable range yields no chunks (logged).
        """
        track_id, sep, rng = target_id.partition("@")
        if not sep or not track_id:
            log.warning("track_ref_no_range", target_id=target_id)
            return []
        start_s, dash, end_s = rng.partition("-")
        if not dash:
            log.warning("track_ref_bad_range", target_id=target_id)
            return []
        try:
            lo = int(start_s)
            hi = int(end_s)
        except ValueError:
            log.warning("track_ref_bad_range", target_id=target_id)
            return []
        if hi < lo:
            log.warning("track_ref_bad_range", target_id=target_id)
            return []

        where = [
            "track_id = $1",
            "embed_model = $2",
            "kind = 'track_transcript'",
            "end_ms >= $3",
            "start_ms <= $4",
        ]
        params: list[Any] = [track_id, self._embed_model, lo, hi]
        if lang:
            where.append(f"lang = ${len(params) + 1}")
            params.append(lang)
        sql = f"""
          SELECT track_id, lang, start_ms, end_ms, text, reference_source_id
          FROM chunks
          WHERE {' AND '.join(where)}
          ORDER BY start_ms
        """
        async with self._pool.acquire() as conn:
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

    # ── Private lane owner records ───────────────────────────────────────

    async def purge_owner(self, user_id: str) -> dict[str, int]:
        return await self._owners.purge_owner(user_id)

    async def get_owned_track_ids(self, user_id: str) -> list[str]:
        return await self._owners.get_owned_track_ids(user_id)

    async def get_owned_track_ids_by_author(
        self, user_id: str, author_ids: list[str], author_raws: list[str] | None = None,
    ) -> list[str]:
        return await self._owners.get_owned_track_ids_by_author(user_id, author_ids, author_raws)

    async def get_own_author_names(self, user_id: str) -> list[str]:
        return await self._owners.get_own_author_names(user_id)

    async def owned_langs_for_authors(
        self, user_id: str, author_ids: list[str], author_raws: list[str],
    ) -> list[str]:
        return await self._owners.owned_langs_for_authors(user_id, author_ids, author_raws)

    async def unattributed_owned_count(self, user_id: str) -> int:
        return await self._owners.unattributed_owned_count(user_id)

    # ── Library lanes ────────────────────────────────────────────────────

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
        return await self._library.search_library_by_embedding(
            embedding, kinds=kinds, source_id=source_id, author_id=author_id, lang=lang,
            date_from=date_from, date_to=date_to, top_k=top_k,
        )

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
        return await self._library.search_chunks_lexical(
            query_text, query_embedding, kinds=kinds, lang=lang, source_id=source_id,
            author_id=author_id, date_from=date_from, date_to=date_to, top_k=top_k,
            trgm_min_sim=trgm_min_sim,
        )

    async def get_chunks_by_addr_label(
        self,
        addr_label: str,
        *,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        return await self._library.get_chunks_by_addr_label(addr_label, kinds=kinds, lang=lang)

    async def get_chunks_by_verse(
        self,
        *,
        source_id: str,
        tokens: str,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        return await self._library.get_chunks_by_verse(
            source_id=source_id, tokens=tokens, kinds=kinds, lang=lang,
        )

    async def get_chunks_by_target(
        self,
        *,
        ref_kind: str,
        target_id: str,
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        return await self._library.get_chunks_by_target(
            ref_kind=ref_kind, target_id=target_id, lang=lang,
        )

    # ── Curated attributions ─────────────────────────────────────────────

    async def find_attributions(
        self,
        embedding: list[float],
        *,
        kind: str,
        lang: str | None,
    ) -> list[AttributionCandidate]:
        return await self._attributions.find_attributions(embedding, kind=kind, lang=lang)

    async def attribution_texts(
        self, attribution_id: str, *, lang: str | None,
    ) -> list[str]:
        return await self._attributions.attribution_texts(attribution_id, lang=lang)

    async def fetch_attribution_note(
        self, attribution_id: str, *, lang: str,
    ) -> str | None:
        return await self._attributions.fetch_attribution_note(attribution_id, lang=lang)
