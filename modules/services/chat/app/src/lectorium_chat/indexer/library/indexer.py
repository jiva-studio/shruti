"""Library indexer orchestrator.

Mirrors `indexer/run.py::_process_one` / `run_once` but for library items.
Diff is per (item_id, lang, embed_model) by content_hash; embed in
batches; upsert into the unified `chunks` table with `kind` set to the
appropriate library kind ('verse' / 'commentary' / 'prose_chapter' /
'letter').
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Iterable

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer.embed import Embedder, get_embedder
from lectorium_chat.indexer.library import db as library_db
from lectorium_chat.indexer.library.chunker import (
    LibraryChunk,
    hash_body,
    load_source_short_names,
    walk_documents,
    walk_verses,
)
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


# How many items get embedded + upserted per commit cycle. Each cycle is
# its own Postgres transaction: chunks + indexed_items.etag are written
# atomically, so a crash mid-loop leaves completed cycles durably indexed.
# The next run sees their hashes match in `library_diff` and skips them,
# re-indexing only the tail that didn't make it. 64 keeps the cycle short
# (~1-2 s embed + small txn) while still amortising OpenAI batch overhead
# (embed_documents batches internally to 96 per HTTP call).
ITEM_BATCH = 64

# item_kind values produced by the library chunker.
LIBRARY_KINDS = ("verse", "commentary", "prose_chapter", "letter")


async def run_once_library(settings: Settings | None = None) -> dict:
    """One library indexing pass — diff, embed changed, upsert, GC."""
    s = settings or get_settings()

    # Pull latest library.db (no-op if version unchanged).
    swapped = await library_db.ensure_library(s)
    if swapped is None and not s.library_db_path.exists():
        log.info("library_index_skip", reason="no_library_db")
        return {"items_total": 0, "chunks_total": 0, "items_changed": 0}

    if not s.catalog_db_path.exists():
        log.warning("library_index_skip", reason="catalog_db_missing")
        return {"items_total": 0, "chunks_total": 0, "items_changed": 0}

    embedder = get_embedder(s)
    pool = get_pool()

    short_names = load_source_short_names(s.catalog_db_path)
    langs = s.langs

    t0 = time.monotonic()
    item_chunks: dict[tuple[str, str], list[LibraryChunk]] = defaultdict(list)
    for chunk in walk_verses(s.library_db_path, short_names, langs=langs):
        item_chunks[(chunk.item_id, chunk.lang)].append(chunk)
    for chunk in walk_documents(s.library_db_path, short_names, langs=langs):
        item_chunks[(chunk.item_id, chunk.lang)].append(chunk)

    items_total = len(item_chunks)
    log.info(
        "library_walk_complete",
        items_total=items_total,
        chunks_total=sum(len(v) for v in item_chunks.values()),
        duration_ms=int((time.monotonic() - t0) * 1000),
    )

    # Load existing hashes for diff
    async with pool.acquire() as conn:
        indexed = await conn.fetch(
            """
            SELECT item_id, lang, etag
            FROM indexed_items
            WHERE item_kind = ANY($1::text[]) AND embed_model = $2
            """,
            list(LIBRARY_KINDS), embedder.name,
        )
    indexed_hash = {(r["item_id"], r["lang"]): r["etag"] for r in indexed}

    # Compute content hash per item — includes BOTH the chunk text AND the
    # composed addr_label, so an update to catalog.sources.short_name (which
    # changes addr_label without changing text) triggers a reindex of just
    # the affected items. Without this the documents' addr_label column
    # stays stale until library.db itself republishes.
    changed: list[tuple[tuple[str, str], list[LibraryChunk], str]] = []
    for (item_id, lang), chunks in item_chunks.items():
        body = "\n\n---\n\n".join(
            f"{c.addr_label}\t{c.text}" for c in chunks
        )
        h = hash_body(body)
        if indexed_hash.get((item_id, lang)) != h:
            changed.append(((item_id, lang), chunks, h))

    log.info(
        "library_diff",
        items_total=items_total,
        items_changed=len(changed),
        embed_model=embedder.name,
    )

    # GC: items present in indexed_items (library kinds) but no longer in library.db
    current_keys = set(item_chunks.keys())
    stale = [k for k in indexed_hash if k not in current_keys]
    if stale:
        async with pool.acquire() as conn:
            await conn.executemany(
                "DELETE FROM chunks WHERE item_id=$1 AND lang=$2",
                stale,
            )
            await conn.executemany(
                """
                DELETE FROM indexed_items
                WHERE item_kind = ANY($1::text[])
                  AND item_id = $2 AND lang = $3 AND embed_model = $4
                """,
                [(list(LIBRARY_KINDS), i, l, embedder.name) for (i, l) in stale],
            )
        log.info("library_gc", removed=len(stale))

    if not changed:
        return {"items_total": items_total, "chunks_total": 0, "items_changed": 0}

    # Process in commit cycles of ITEM_BATCH items. Each cycle: embed →
    # one transaction that upserts chunks + indexed_items together.
    # `indexed_items.etag` only becomes durable when its cycle commits, so
    # a crash mid-loop leaves the finished cycles indexed and the rest
    # picked up by the next run's diff.
    chunks_total = 0
    items_done = 0
    items_remaining = len(changed)
    for cycle_start in range(0, len(changed), ITEM_BATCH):
        cycle = changed[cycle_start:cycle_start + ITEM_BATCH]

        flat: list[LibraryChunk] = []
        item_offsets: list[tuple[tuple[str, str], int, int, str]] = []
        for key, chunks, h in cycle:
            start = len(flat)
            flat.extend(chunks)
            item_offsets.append((key, start, len(flat), h))

        cycle_t0 = time.monotonic()
        vectors = await embedder.embed_documents([c.text for c in flat])
        if len(vectors) != len(flat):
            raise RuntimeError(
                f"embedder returned {len(vectors)} vectors for {len(flat)} texts"
            )

        async with pool.acquire() as conn:
            async with conn.transaction():
                for (item_id, lang), start, end, h in item_offsets:
                    item_kind = flat[start].item_kind
                    await conn.execute(
                        "DELETE FROM chunks WHERE item_id=$1 AND lang=$2 AND embed_model=$3",
                        item_id, lang, embedder.name,
                    )
                    rows = [
                        (c.item_kind, c.lang, c.text,
                         c.source_id, c.tokens, c.author_id, c.doc_date,
                         c.item_id, c.segment_index, c.addr_label,
                         embedder.name, v)
                        for c, v in zip(flat[start:end], vectors[start:end], strict=True)
                    ]
                    if rows:
                        await conn.executemany(
                            """
                            INSERT INTO chunks
                              (kind, lang, text,
                               source_id, tokens, author_id, doc_date,
                               item_id, segment_index, addr_label,
                               embed_model, embedding)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                            """,
                            rows,
                        )
                        chunks_total += len(rows)
                    await conn.execute(
                        """
                        INSERT INTO indexed_items
                          (item_kind, item_id, lang, embed_model, etag, indexed_at)
                        VALUES ($1, $2, $3, $4, $5, NOW())
                        ON CONFLICT (item_kind, item_id, lang, embed_model)
                        DO UPDATE SET etag=$5, indexed_at=NOW()
                        """,
                        item_kind, item_id, lang, embedder.name, h,
                    )

        items_done += len(cycle)
        log.info(
            "library_embed_progress",
            items_done=items_done,
            items_total=items_remaining,
            chunks_written=chunks_total,
            cycle_ms=int((time.monotonic() - cycle_t0) * 1000),
        )

    log.info(
        "library_index_complete",
        items_changed=len(changed),
        chunks_written=chunks_total,
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return {
        "items_total": items_total,
        "items_changed": len(changed),
        "chunks_total": chunks_total,
    }
