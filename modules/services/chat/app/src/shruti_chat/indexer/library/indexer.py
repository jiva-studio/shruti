"""Library indexer orchestrator.

Mirrors `indexer/run.py::_process_one` / `run_once` but for library items.
Diff is per (item_id, lang, embed_model) by content_hash; embed in
batches; upsert into the unified `chunks` table with `kind` set to the
appropriate library kind ('verse' / 'commentary' / 'prose_chapter' /
'letter').

Walk is streamed: chunks for one (item_id, lang) are grouped from the
chunker output via itertools.groupby (both walk_verses and walk_documents
yield chunks for one (item_id, lang) consecutively), hashed, diffed,
and either skipped or buffered into the next embed cycle. Peak RAM is
bounded by ITEM_BATCH items * ~38 chunks * ~1 KB ≈ a few MB, regardless
of how many items live in library.db.
"""

from __future__ import annotations

import itertools
import time
from typing import Iterable, Iterator

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer._gc import (
    delete_stale_library_items,
    gc_would_prune_too_much,
)
from shruti_chat.indexer.embed import Embedder, get_embedder  # noqa: F401
from shruti_chat.indexer.library import db as library_db
from shruti_chat.indexer.library.chunker import (
    LibraryChunk,
    hash_body,
    load_source_short_names,
    walk_documents,
    walk_media,
    walk_titles,
    walk_verses,
)
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


# How many items get embedded + upserted per commit cycle. Each cycle is
# its own Postgres transaction: chunks + indexed_items.etag are written
# atomically, so a crash mid-loop leaves completed cycles durably indexed.
# The next run sees their hashes match in `library_diff` and skips them,
# re-indexing only the tail that didn't make it. 64 keeps the cycle short
# (~1-2 s embed + small txn) while still amortising OpenAI batch overhead
# (embed_documents batches internally to 96 per HTTP call).
ITEM_BATCH = 64

# item_kind values produced by the library chunker. `title` and `media`
# are emitted by walk_titles / walk_media respectively; both must be in
# the diff/GC set so their indexed_items rows are loaded and reclaimed.
LIBRARY_KINDS = ("verse", "title", "commentary", "prose_chapter", "letter", "media")


def _stream_items(
    library_db_path,
    short_names: dict[tuple[str, str], str],
    *,
    langs: list[str],
) -> Iterator[tuple[tuple[str, str], list[LibraryChunk]]]:
    """Yield (item_id, lang) → list[chunks] one item at a time.

    Both walk_verses and walk_documents emit chunks for one (item_id, lang)
    consecutively (verses produce a single chunk per pair; documents
    iterate segments within a (doc, lang) variant before moving on), so
    itertools.groupby groups correctly without buffering the whole walk.
    """
    chunk_stream: Iterable[LibraryChunk] = itertools.chain(
        walk_verses(library_db_path, short_names, langs=langs),
        walk_titles(library_db_path, short_names, langs=langs),
        walk_documents(library_db_path, short_names, langs=langs),
        # Media rows are pre-chunked (one atomic chunk per row) and carry
        # their own embed_text, so walk_media needs no short_names.
        walk_media(library_db_path, langs=langs),
    )
    for key, group in itertools.groupby(
        chunk_stream, key=lambda c: (c.item_id, c.lang)
    ):
        yield key, list(group)


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
    # Per-dim destination table for chunk embeddings (migration 0030).
    router = EmbeddingTableRouter(dim=s.embed_dim)
    pool = get_pool()

    short_names = load_source_short_names(s.catalog_db_path)
    langs = s.langs

    # Load existing hashes for diff. Bounded ~80k rows of
    # (item_id, lang, etag) → ~10 MB resident. Cheap compared to
    # accumulating the full chunk corpus.
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

    async def _flush(cycle: list[tuple[tuple[str, str], list[LibraryChunk], str]]) -> int:
        """Embed + commit one cycle's worth of items. Returns chunks written."""
        flat: list[LibraryChunk] = []
        item_offsets: list[tuple[tuple[str, str], int, int, str]] = []
        for key, chunks, h in cycle:
            start = len(flat)
            flat.extend(chunks)
            item_offsets.append((key, start, len(flat), h))

        cycle_t0 = time.monotonic()
        # Media chunks carry a precomputed `embed_text` (facts+context+text)
        # that is what we embed; verses/documents have none and embed their
        # display `text` as before. COALESCE keeps both paths in one call.
        vectors = await embedder.embed_documents(
            [c.embed_text or c.text for c in flat]
        )
        if len(vectors) != len(flat):
            raise RuntimeError(
                f"embedder returned {len(vectors)} vectors for {len(flat)} texts"
            )

        cycle_chunks = 0
        async with pool.acquire() as conn:
            async with conn.transaction():
                for (item_id, lang), start, end, h in item_offsets:
                    # FK CASCADE drops matching d{N} rows automatically.
                    await conn.execute(
                        "DELETE FROM chunks WHERE item_id=$1 AND lang=$2 AND embed_model=$3",
                        item_id, lang, embedder.name,
                    )
                    item_chunks_list = flat[start:end]
                    item_vectors = vectors[start:end]
                    if not item_chunks_list:
                        continue
                    n = len(item_chunks_list)
                    # Bulk insert via UNNEST keeps INSERT...RETURNING
                    # ordered, so chunk_ids align with item_vectors.
                    id_rows = await conn.fetch(
                        """
                        INSERT INTO chunks
                          (kind, lang, text,
                           source_id, tokens, author_id, doc_date,
                           item_id, segment_index, addr_label,
                           embed_model)
                        SELECT * FROM UNNEST(
                          $1::text[], $2::text[], $3::text[],
                          $4::text[], $5::text[], $6::text[], $7::text[],
                          $8::text[], $9::int[], $10::text[],
                          $11::text[]
                        )
                        RETURNING id
                        """,
                        [c.item_kind for c in item_chunks_list],
                        [c.lang for c in item_chunks_list],
                        [c.text for c in item_chunks_list],
                        [c.source_id for c in item_chunks_list],
                        [c.tokens for c in item_chunks_list],
                        [c.author_id for c in item_chunks_list],
                        [c.doc_date for c in item_chunks_list],
                        [c.item_id for c in item_chunks_list],
                        [c.segment_index for c in item_chunks_list],
                        [c.addr_label for c in item_chunks_list],
                        [embedder.name] * n,
                    )
                    chunk_ids = [int(r["id"]) for r in id_rows]
                    # kind/lang denormalized onto the embedding row
                    # (migration 0035) for the per-kind partial HNSW index.
                    await conn.executemany(
                        f"""
                        INSERT INTO {router.chunk_table} (chunk_id, embedding, kind, lang)
                        VALUES ($1, $2, $3, $4)
                        """,
                        list(zip(
                            chunk_ids, item_vectors,
                            [c.item_kind for c in item_chunks_list],
                            [c.lang for c in item_chunks_list],
                            strict=True,
                        )),
                    )
                    cycle_chunks += n
                    await conn.execute(
                        """
                        INSERT INTO indexed_items
                          (item_kind, item_id, lang, embed_model, etag, indexed_at)
                        VALUES ($1, $2, $3, $4, $5, NOW())
                        ON CONFLICT (item_kind, item_id, lang, embed_model)
                        DO UPDATE SET etag=$5, indexed_at=NOW()
                        """,
                        item_chunks_list[0].item_kind,
                        item_id, lang, embedder.name, h,
                    )
        log.info(
            "library_embed_cycle",
            items_in_cycle=len(item_offsets),
            chunks_written_cycle=cycle_chunks,
            cycle_ms=int((time.monotonic() - cycle_t0) * 1000),
        )
        return cycle_chunks

    t0 = time.monotonic()
    current_keys: set[tuple[str, str]] = set()
    buffer: list[tuple[tuple[str, str], list[LibraryChunk], str]] = []
    items_total = 0
    items_changed = 0
    chunks_total = 0

    for (item_id, lang), chunks in _stream_items(
        s.library_db_path, short_names, langs=langs
    ):
        items_total += 1
        current_keys.add((item_id, lang))

        # Content hash covers chunk text AND the composed addr_label, so
        # an update to catalog.sources.short_name (which changes addr_label
        # without changing text) triggers a reindex of just the affected
        # items. Without this the documents' addr_label column stays stale
        # until library.db itself republishes.
        # For media, fold embed_text into the hash so a change to the
        # embedded string (which doesn't touch display `text`) triggers a
        # re-embed. The per-chunk form is only widened when embed_text is
        # actually set, so verse/document hashes are byte-for-byte
        # unchanged from before this column existed — NO corpus reindex.
        body = "\n\n---\n\n".join(
            f"{c.addr_label}\t{c.embed_text}\t{c.text}"
            if c.embed_text
            else f"{c.addr_label}\t{c.text}"
            for c in chunks
        )
        h = hash_body(body)
        if indexed_hash.get((item_id, lang)) == h:
            # Unchanged — drop the chunks; they go out of scope and the
            # GC reclaims memory before the next item is walked.
            continue

        items_changed += 1
        buffer.append(((item_id, lang), chunks, h))

        if len(buffer) >= ITEM_BATCH:
            chunks_total += await _flush(buffer)
            buffer.clear()

    # Final partial cycle.
    if buffer:
        chunks_total += await _flush(buffer)
        buffer.clear()

    log.info(
        "library_walk_complete",
        items_total=items_total,
        items_changed=items_changed,
        embed_model=embedder.name,
        duration_ms=int((time.monotonic() - t0) * 1000),
    )

    # GC: items present in indexed_items (library kinds) but no longer in library.db.
    # `current_keys` was populated during the streaming walk above.
    #
    # Guarded the same way the transcript GC is: a walk that yielded nothing
    # means the library.db read failed or the file was swapped mid-pass — not
    # that every item was deleted. The share check then covers a walk that came
    # back partially populated, which loses data the same way.
    stale = [k for k in indexed_hash if k not in current_keys] if items_total else []
    if stale and gc_would_prune_too_much(len(stale), len(indexed_hash)):
        log.warning(
            "library_gc_refused",
            stale=len(stale),
            indexed=len(indexed_hash),
            walked=items_total,
        )
        stale = []
    if stale:
        await delete_stale_library_items(
            pool, stale, embedder.name, LIBRARY_KINDS,
        )
        log.info("library_gc", removed=len(stale))

    log.info(
        "library_index_complete",
        items_changed=items_changed,
        chunks_written=chunks_total,
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return {
        "items_total": items_total,
        "items_changed": items_changed,
        "chunks_total": chunks_total,
    }
