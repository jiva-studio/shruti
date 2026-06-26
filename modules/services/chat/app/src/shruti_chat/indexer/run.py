"""Indexer scheduler — bootstrap + periodic refresh.

Two phases:
1. Bootstrap (synchronous on cold start): ensure catalog is present, then return.
   This unblocks /readyz; transcript indexing continues in the background.
2. Periodic loop: every INDEXER_INTERVAL_HOURS, refresh catalog + diff transcripts.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import suppress

import structlog

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer import catalog, s3
from shruti_chat.indexer.chunker import Chunk, chunk_reviewed
from shruti_chat.indexer.embed import Embedder, get_embedder
from shruti_chat.indexer.library import db as library_db
from shruti_chat.indexer.library.attribution_indexer import run_once_attribution
from shruti_chat.indexer.library.indexer import run_once_library
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


# ── Bootstrap ──────────────────────────────────────────────────────────


async def bootstrap_catalog(settings: Settings | None = None) -> None:
    """Synchronous catalog presence check + initial download if missing.

    Called from main.py lifespan before /readyz can return ready=true.
    Also marks any leftover `running` indexer runs (from a previous crash
    or rolling restart) as `failed`, so /status reflects reality.
    """
    s = settings or get_settings()
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE indexer_runs
            SET state='failed', finished_at=NOW(), error='abandoned at restart'
            WHERE state='running'
            """,
        )
    await catalog.ensure_catalog(s)
    # Library bootstrap happens AFTER catalog so the chunker can read
    # sources.short_name for addr_label composition. Failure to bootstrap
    # library is non-fatal — older deployments may not have run
    # library.publish yet.
    try:
        await library_db.ensure_library(s)
    except Exception as exc:
        log.error("library_bootstrap_failed", error=str(exc))


# ── Periodic loop ──────────────────────────────────────────────────────


async def scheduler_loop(settings: Settings | None = None, stop_event: asyncio.Event | None = None) -> None:
    s = settings or get_settings()
    stop = stop_event or asyncio.Event()
    interval = max(60, s.indexer_interval_hours * 3600)

    # First run on boot — already loads in the background after bootstrap.
    while not stop.is_set():
        try:
            await run_once(s, trigger="scheduled")
        except Exception as exc:
            log.exception("indexer_loop_iteration_failed", error=str(exc))
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


# ── One run ────────────────────────────────────────────────────────────


async def run_once(
    settings: Settings | None = None,
    *,
    trigger: str = "manual",
    track_ids_filter: list[str] | None = None,
    lang_filter: str | None = None,
    force_catalog: bool = False,
) -> str:
    """Execute one indexer pass. Returns the run_id."""
    s = settings or get_settings()
    embedder = get_embedder(s)
    pool = get_pool()
    run_id = f"r-{uuid.uuid4().hex[:8]}"
    structlog.contextvars.bind_contextvars(run_id=run_id)
    try:
        log.info("indexer_run_start", trigger=trigger)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO indexer_runs (run_id, state, trigger, started_at)
                VALUES ($1, 'running', $2, NOW())
                """,
                run_id, trigger,
            )

        catalog_from = await catalog.read_current_version()
        catalog_to = None
        try:
            catalog_to = await catalog.ensure_catalog(s, force=force_catalog) or catalog_from
        except Exception as exc:
            log.error("catalog_refresh_failed", error=str(exc))

        # List all transcripts on the requested languages
        langs = [lang_filter] if lang_filter else s.langs
        objects = await asyncio.to_thread(s3.list_transcripts, langs, s)
        if track_ids_filter:
            objects = [o for o in objects if o.track_id in set(track_ids_filter)]
        log.info("transcript_discovered", total=len(objects), langs=langs)

        # Diff against indexed_items for the active embed_model (track kind)
        async with pool.acquire() as conn:
            indexed = await conn.fetch(
                """
                SELECT item_id, lang, etag FROM indexed_items
                WHERE item_kind = 'track_transcript' AND embed_model = $1
                """,
                embedder.name,
            )
        indexed_map = {(r["item_id"], r["lang"]): r["etag"] for r in indexed}
        to_process = [o for o in objects if indexed_map.get((o.track_id, o.lang)) != o.etag]
        log.info(
            "transcript_diff",
            total=len(objects),
            to_process=len(to_process),
            embed_model=embedder.name,
        )

        # GC: tracks indexed but no longer present in the catalog. Guarded
        # against an empty listing: list_transcripts() returns [] when the
        # published catalog has no asset_hashes yet (rollout race) or a fetch
        # failed — that is NOT "every transcript was deleted". Pruning on an
        # empty listing once wiped the whole transcript corpus; never GC unless
        # the listing actually returned something. A real full-delete would
        # require the catalog to legitimately drop to zero transcripts, which
        # does not happen in practice.
        objects_set = {(o.track_id, o.lang) for o in objects}
        stale = [k for k in indexed_map if k not in objects_set] if objects else []
        if stale:
            async with pool.acquire() as conn:
                await conn.executemany(
                    "DELETE FROM chunks WHERE track_id = $1 AND lang = $2",
                    stale,
                )
                await conn.executemany(
                    """
                    DELETE FROM indexed_items
                    WHERE item_kind = 'track_transcript'
                      AND item_id = $1 AND lang = $2 AND embed_model = $3
                    """,
                    [(t, lang, embedder.name) for t, lang in stale],
                )
            log.info("transcript_gc", removed=len(stale))

        # Parallel processing: API embedder + HTTP S3 fetches are I/O bound,
        # 8 concurrent workers ≈ 5-7× speed-up over serial.
        chunks_total = 0
        tracks_done = 0
        progress_lock = asyncio.Lock()
        sem = asyncio.Semaphore(8)

        async def worker(obj: s3.TranscriptObject) -> None:
            nonlocal chunks_total, tracks_done
            async with sem:
                try:
                    added = await _process_one(obj, embedder, settings=s)
                except Exception as exc:
                    log.exception(
                        "transcript_index_failed",
                        track_id=obj.track_id, lang=obj.lang, error=str(exc),
                    )
                    added = 0
                async with progress_lock:
                    chunks_total += added
                    tracks_done += 1
                    if tracks_done % 20 == 0:
                        async with pool.acquire() as conn:
                            await conn.execute(
                                """
                                UPDATE indexer_runs SET tracks_done = $1, chunks_total = $2
                                WHERE run_id = $3
                                """,
                                tracks_done, chunks_total, run_id,
                            )

        await asyncio.gather(*(worker(o) for o in to_process))

        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE indexer_runs
                SET state='success', finished_at=NOW(),
                    tracks_done=$1, chunks_total=$2,
                    catalog_from=$3, catalog_to=$4
                WHERE run_id=$5
                """,
                len(to_process), chunks_total,
                catalog_from, catalog_to, run_id,
            )
        log.info(
            "indexer_run_complete",
            tracks_indexed=len(to_process),
            chunks_total=chunks_total,
        )

        # Library pass — independent of transcript indexing. Errors here
        # must not fail the run (transcripts are the headline content;
        # library is opportunistic).
        library_ok = False
        try:
            lib_stats = await run_once_library(s)
            log.info("library_run_complete", **lib_stats)
            library_ok = True
        except Exception as exc:
            log.exception("library_run_failed", error=str(exc))

        # Attribution pass — depends on the library tables having just
        # been refreshed. If library failed, the verse / document refs
        # the attributions point at may have moved or been removed in
        # the artefact we didn't load; running attribution against the
        # previous library state would persist orphan or wrongly-aliased
        # rows. Skip and try again next tick.
        if library_ok:
            try:
                attr_stats = await run_once_attribution(s)
                log.info("attribution_run_complete", **attr_stats)
            except Exception as exc:
                log.exception("attribution_run_failed", error=str(exc))
        else:
            log.warning(
                "attribution_run_skipped",
                reason="library_pass_failed",
            )

        return run_id
    except Exception as exc:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE indexer_runs
                SET state='failed', finished_at=NOW(), error=$1
                WHERE run_id=$2
                """,
                str(exc), run_id,
            )
        log.exception("indexer_run_failed", error=str(exc))
        raise
    finally:
        structlog.contextvars.unbind_contextvars("run_id")


async def _process_one(obj: s3.TranscriptObject, embedder: Embedder, settings: Settings) -> int:
    """Fetch one transcript, chunk, embed, upsert, mark indexed. Returns chunk count."""
    t0 = time.monotonic()
    reviewed = await s3.fetch_transcript(obj.key, settings)
    chunks = chunk_reviewed(reviewed)
    if not chunks:
        async with get_pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO indexed_items
                  (item_kind, item_id, lang, embed_model, etag, indexed_at)
                VALUES ('track_transcript', $1, $2, $3, $4, NOW())
                ON CONFLICT (item_kind, item_id, lang, embed_model)
                DO UPDATE SET etag=$4, indexed_at=NOW()
                """,
                obj.track_id, obj.lang, embedder.name, obj.etag,
            )
        return 0

    vectors = await embedder.embed_documents([c.text for c in chunks])
    # Embedding column is no longer on `chunks` after migration 0030 —
    # the active dim's per-dim table receives the vectors. Indexer
    # routes through `EmbeddingTableRouter`; FK CASCADE on chunk_id
    # means deleting the chunks row also removes its embedding row.
    router = EmbeddingTableRouter(dim=settings.embed_dim)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Cascading delete: dropping the chunks row removes any
            # matching d{N} embedding rows automatically (FK CASCADE).
            await conn.execute(
                "DELETE FROM chunks WHERE track_id=$1 AND lang=$2 AND embed_model=$3",
                obj.track_id, obj.lang, embedder.name,
            )
            # Bulk insert metadata rows via UNNEST; RETURNING id keeps
            # the (chunk, embedding) zip aligned because UNNEST preserves
            # input order. Then bulk-insert the matching d{N} rows.
            track_ids = [c.track_id for c in chunks]
            langs = [c.lang for c in chunks]
            starts = [c.start_ms for c in chunks]
            ends = [c.end_ms for c in chunks]
            texts = [c.text for c in chunks]
            ref_src = [c.reference_source_id for c in chunks]
            id_rows = await conn.fetch(
                """
                INSERT INTO chunks
                  (track_id, lang, start_ms, end_ms, text,
                   reference_source_id, embed_model)
                SELECT * FROM UNNEST(
                  $1::text[], $2::text[], $3::int[], $4::int[], $5::text[],
                  $6::text[], $7::text[]
                )
                RETURNING id
                """,
                track_ids, langs, starts, ends, texts, ref_src,
                [embedder.name] * len(chunks),
            )
            chunk_ids = [int(r["id"]) for r in id_rows]
            # kind/lang denormalized onto the embedding row (migration 0035)
            # so the per-kind partial HNSW index can be used at query time.
            # Lecture chunks are always 'track_transcript'.
            await conn.executemany(
                f"""
                INSERT INTO {router.chunk_table} (chunk_id, embedding, kind, lang)
                VALUES ($1, $2, 'track_transcript', $3)
                """,
                list(zip(chunk_ids, vectors, langs, strict=True)),
            )
            await conn.execute(
                """
                INSERT INTO indexed_items
                  (item_kind, item_id, lang, embed_model, etag, indexed_at)
                VALUES ('track_transcript', $1, $2, $3, $4, NOW())
                ON CONFLICT (item_kind, item_id, lang, embed_model)
                DO UPDATE SET etag=$4, indexed_at=NOW()
                """,
                obj.track_id, obj.lang, embedder.name, obj.etag,
            )

    log.info(
        "chunk_track_done",
        track_id=obj.track_id,
        lang=obj.lang,
        chunks_created=len(chunks),
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return len(chunks)
