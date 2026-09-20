"""Indexer scheduler — bootstrap + periodic refresh.

Two phases:
1. Bootstrap (synchronous on cold start): ensure catalog is present, then return.
   This unblocks /readyz; transcript indexing continues in the background.
2. Periodic loop: every INDEXER_INTERVAL_HOURS, refresh catalog + diff transcripts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from contextlib import suppress

import httpx
import structlog

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer import catalog, s3
from lectorium_chat.indexer._gc import (
    delete_stale_transcripts,
    gc_would_prune_too_much,
)
from lectorium_chat.indexer.chunker import chunk_reviewed
from lectorium_chat.indexer.embed import Embedder, get_embedder
from lectorium_chat.indexer.library import db as library_db
from lectorium_chat.indexer.library.attribution_indexer import run_once_attribution
from lectorium_chat.indexer.library.indexer import run_once_library
from lectorium_chat.indexer.orchestrator_adapter import (
    orchestrator_transcript_to_reviewed,
)
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.observability.logging import get_logger

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
        log.exception("library_bootstrap_failed", error=str(exc))


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
            log.exception("catalog_refresh_failed", error=str(exc))

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
        if stale and gc_would_prune_too_much(len(stale), len(indexed_map)):
            # A partially-populated listing passes the empty guard above and
            # loses data the same way. Refuse and say so.
            log.warning(
                "transcript_gc_refused",
                stale=len(stale),
                indexed=len(indexed_map),
                listed=len(objects),
            )
            stale = []
        if stale:
            await delete_stale_transcripts(pool, stale, embedder.name)
            log.info("transcript_gc", removed=len(stale))

        # Parallel processing: API embedder + HTTP S3 fetches are I/O bound,
        # so a handful of concurrent workers is a 5-7x speed-up over serial.
        # Each holds a pool connection and an embedding call, and this runs
        # alongside live traffic — hence configurable.
        chunks_total = 0
        tracks_done = 0
        assets_missing = 0
        progress_lock = asyncio.Lock()
        sem = asyncio.Semaphore(max(1, s.indexer_concurrency))

        async def worker(obj: s3.TranscriptObject) -> None:
            nonlocal chunks_total, tracks_done, assets_missing
            async with sem:
                try:
                    added = await _process_one(obj, embedder, settings=s)
                except Exception as exc:
                    if _is_missing_asset(exc):
                        # Not an indexing failure: the catalog advertises a
                        # transcript that was never uploaded, and it repeats
                        # every run until the publisher stops advertising it.
                        assets_missing += 1
                        log.warning(
                            "transcript_asset_missing",
                            track_id=obj.track_id, lang=obj.lang, key=obj.key,
                            hint="asset_hashes row with no object on the CDN — "
                                 "run assetsync for the track, or drop the "
                                 "variant, then republish the catalog",
                        )
                    else:
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
            assets_missing=assets_missing,
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


def _is_missing_asset(exc: BaseException) -> bool:
    """True when the CDN says the advertised transcript is not there.

    A 404 is a defect in the PUBLISHED catalog, not a transient fetch
    error: `list_transcripts` reads `asset_hashes` out of the catalog db
    (Bunny has no anonymous listing), so a row whose object was never
    uploaded is retried on every run forever. lectorium-mcp's publish
    step now refuses to advertise such rows; this only keeps the log
    honest about the ones already out there.
    """
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404


async def _process_one(obj: s3.TranscriptObject, embedder: Embedder, settings: Settings) -> int:
    """Fetch one CORPUS transcript from S3 and index it. Returns chunk count.

    Thin wrapper over `index_one_track` — the public corpus lane fetches the
    reviewed transcript by CDN key and indexes it under
    `kind='track_transcript'` with the catalog sha256 as the change-token.
    """
    reviewed = await s3.fetch_transcript(obj.key, settings)
    return await index_one_track(
        obj.track_id,
        reviewed,
        obj.lang,
        kind="track_transcript",
        embedder=embedder,
        settings=settings,
        etag=obj.etag,
    )


def _content_etag(reviewed: dict) -> str:
    """sha256 over the reviewed payload — the change-token for a user track.

    Corpus tracks carry the catalog's sha256; user tracks arrive as an inline
    transcript with no external etag, so we derive one from the content so a
    re-delivered identical `track.ready` event is a cheap no-op upsert."""
    payload = json.dumps(reviewed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def index_one_track(
    track_id: str,
    transcript_ref: dict | str,
    lang: str,
    *,
    kind: str = "user_track",
    embedder: Embedder | None = None,
    settings: Settings | None = None,
    etag: str | None = None,
) -> int:
    """Chunk → embed → upsert ONE track's transcript. Returns chunk count.

    The shared indexing core for BOTH lanes:
    - public corpus (`kind='track_transcript'`, called by `_process_one`);
    - private per-user tracks (`kind='user_track'`, called by the
      `track.events` consumer for the "add to my library" flow).

    `transcript_ref` is either the transcript payload itself (an orchestrator
    transcript or an already-reviewed dict — normalised via the orchestrator
    adapter) or a CDN key string to fetch it from. `kind` is written to BOTH
    `chunks.kind` and the embedding row's denormalised `kind`, so the private
    lane's rows are structurally invisible to the public `track_transcript`
    partial HNSW index (migration 0043) — the isolation guarantee.

    Who is SPEAKING is not written here: it is one attribute of the whole track,
    so it lives in `chunk_meta` (one row per owner per group), the way a corpus
    lecture's author lives in the catalog rather than on its 524k chunks.
    """
    s = settings or get_settings()
    emb = embedder or get_embedder(s)
    t0 = time.monotonic()

    if isinstance(transcript_ref, str):
        raw = await s3.fetch_transcript(transcript_ref, s)
    else:
        raw = transcript_ref
    reviewed = orchestrator_transcript_to_reviewed(raw, track_id=track_id, lang=lang)
    if etag is None:
        etag = _content_etag(reviewed)

    chunks = chunk_reviewed(reviewed)
    pool = get_pool()
    if not chunks:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO indexed_items
                  (item_kind, item_id, lang, embed_model, etag, indexed_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (item_kind, item_id, lang, embed_model)
                DO UPDATE SET etag=$5, indexed_at=NOW()
                """,
                kind, track_id, lang, emb.name, etag,
            )
        return 0

    vectors = await emb.embed_documents([c.text for c in chunks])
    # Embedding column is no longer on `chunks` after migration 0030 —
    # the active dim's per-dim table receives the vectors. Indexer
    # routes through `EmbeddingTableRouter`; FK CASCADE on chunk_id
    # means deleting the chunks row also removes its embedding row.
    router = EmbeddingTableRouter(dim=s.embed_dim)
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Cascading delete: dropping the chunks row removes any
            # matching d{N} embedding rows automatically (FK CASCADE).
            # Scoped by kind too so re-indexing a user_track can never
            # collide with a same-id public track (content-addressed ids
            # make that near-impossible, but scope defensively).
            await conn.execute(
                "DELETE FROM chunks WHERE track_id=$1 AND lang=$2 "
                "AND embed_model=$3 AND kind=$4",
                track_id, lang, emb.name, kind,
            )
            # Bulk insert metadata rows via UNNEST; RETURNING id keeps
            # the (chunk, embedding) zip aligned because UNNEST preserves
            # input order. `track_id`/`lang`/`kind` are the AUTHORITATIVE
            # values (not the chunk's own copies) so the ACL id and the
            # kind discriminator are consistent for every row.
            n = len(chunks)
            starts = [c.start_ms for c in chunks]
            ends = [c.end_ms for c in chunks]
            texts = [c.text for c in chunks]
            ref_src = [c.reference_source_id for c in chunks]
            id_rows = await conn.fetch(
                """
                INSERT INTO chunks
                  (track_id, lang, start_ms, end_ms, text,
                   reference_source_id, embed_model, kind)
                SELECT * FROM UNNEST(
                  $1::text[], $2::text[], $3::int[], $4::int[], $5::text[],
                  $6::text[], $7::text[], $8::text[]
                )
                RETURNING id
                """,
                [track_id] * n, [lang] * n, starts, ends, texts, ref_src,
                [emb.name] * n, [kind] * n,
            )
            chunk_ids = [int(r["id"]) for r in id_rows]
            # kind/lang denormalized onto the embedding row (migrations 0035 /
            # 0043) so the per-kind partial HNSW index can be used at query
            # time. The private lane writes kind='user_track'.
            await conn.executemany(
                f"""
                INSERT INTO {router.chunk_table} (chunk_id, embedding, kind, lang)
                VALUES ($1, $2, $3, $4)
                """,
                [(cid, vec, kind, lang) for cid, vec in zip(chunk_ids, vectors, strict=True)],
            )
            await conn.execute(
                """
                INSERT INTO indexed_items
                  (item_kind, item_id, lang, embed_model, etag, indexed_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (item_kind, item_id, lang, embed_model)
                DO UPDATE SET etag=$5, indexed_at=NOW()
                """,
                kind, track_id, lang, emb.name, etag,
            )

    log.info(
        "chunk_track_done",
        track_id=track_id,
        lang=lang,
        kind=kind,
        chunks_created=len(chunks),
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return len(chunks)


async def _graft_promoted_track(
    track_id: str, *, settings: Settings | None = None
) -> int:
    """Promote a private `user_track` into the public corpus lane in place.

    When a user-uploaded track is approved and published into the corpus
    (publish-service emits `track.published`), its already-indexed chunks must
    stop being ACL-scoped and start being visible to everyone. Rather than
    re-embedding, we RELABEL the existing rows from `kind='user_track'` to
    `kind='track_transcript'` (moving them onto the public partial-HNSW lane) and
    DROP the track's `chunk_meta` rows — the corpus catalog is the authority for a
    published lecture, so a private record of who may read it and who is speaking
    would be a stale second copy.

    Idempotent: a track that was never a user_track (or was already grafted)
    matches nothing and the call is a cheap no-op. Returns the number of chunk
    rows relabelled. Runs from the `track.published` consumer; the corpus
    indexer remains the safety net that (re)indexes the public transcript.
    """
    s = settings or get_settings()
    router = EmbeddingTableRouter(dim=s.embed_dim)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Relabel the embedding rows FIRST, while their chunks still carry
            # kind='user_track' (the subquery keys off that), so the per-kind
            # partial HNSW index picks them up as public.
            await conn.execute(
                f"""
                UPDATE {router.chunk_table} SET kind = 'track_transcript'
                 WHERE kind = 'user_track'
                   AND chunk_id IN (
                       SELECT id FROM chunks
                        WHERE track_id = $1 AND kind = 'user_track'
                   )
                """,
                track_id,
            )
            relabelled = await conn.execute(
                "UPDATE chunks SET kind = 'track_transcript' "
                "WHERE track_id = $1 AND kind = 'user_track'",
                track_id,
            )
            # The corpus lane is public — drop the private records so the track
            # is no longer treated as owned, and its speaker comes from the
            # catalog like every other corpus lecture's.
            await conn.execute("DELETE FROM chunk_meta WHERE track_id = $1", track_id)
    # asyncpg returns a status string like "UPDATE 12"; parse the count.
    try:
        n = int(str(relabelled).split()[-1])
    except (ValueError, IndexError):
        n = 0
    log.info("user_track_grafted_to_corpus", track_id=track_id, chunks_relabelled=n)
    return n
