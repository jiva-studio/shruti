"""Attribution indexer — mirrors the curated library_attribution* tables from
the published library.db into Postgres `attributions` + `attribution_embeddings`.

Diff strategy is identical to `library/indexer.py`: one `indexed_items` row per
(attribution_id, language) keyed on `item_kind='attribution'`. `etag` is the
sha256 of the sorted-joined text variants for one (id, lang), so adding /
removing / editing ANY variant in a language triggers re-embed of all variants
for that (id, lang). Refs (the JSONB metadata in `attributions`) are upserted
unconditionally on every pass — refs changes alone don't require re-embed.

GC has two passes:
  - per-(id, lang) stale: text removed from library.db
  - per-id orphan: the entire attribution row removed from library.db
    (FK CASCADE on attribution_embeddings handles its rows automatically)
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer.embed import get_embedder
from shruti_chat.indexer.library.chunker import split_into_chunks
from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

INDEXED_KIND_ATTRIBUTION = "attribution"


def _walk_attributions(library_db_path: Path) -> tuple[
    dict[str, str],                            # id → kind
    dict[tuple[str, str], list[str]],          # (id, lang) → sorted embed texts
    dict[str, list[dict]],                     # id → refs list
    dict[tuple[str, str], str],                # (id, lang) → note text (memory)
]:
    """Single pass over library.db. Returns (kinds, embed_sets, refs_map, notes).

    `embed_sets[(id, lang)]` is everything to embed for that pair: the trigger
    phrases PLUS the chunks of the memory note (so a query close to the note
    content surfaces the memory, not only its triggers). Sorted within each
    pair so the etag is stable regardless of SQLite row order.

    `notes[(id, lang)]` is the FULL note text (one per language) — embedded via
    `embed_sets`, but kept whole here so the indexer can mirror it into
    `attribution_notes` for injection-time fetch.

    Refs are sorted by (position, ref_kind, target_id); the optional `language`
    key is included only when set — refs JSONB is normalised before upsert.
    """
    attrs: dict[str, str] = {}
    triggers: dict[tuple[str, str], list[str]] = defaultdict(list)
    notes: dict[tuple[str, str], str] = {}
    refs_map: dict[str, list[dict]] = defaultdict(list)

    with sqlite3.connect(f"file:{library_db_path}?mode=ro", uri=True) as conn:
        for aid, kind in conn.execute("SELECT id, kind FROM library_attributions"):
            attrs[aid] = kind

        for aid, lang, text in conn.execute(
            "SELECT attribution_id, language, text "
            "FROM library_attribution_triggers "
            "ORDER BY attribution_id, language, text"
        ):
            triggers[(aid, lang)].append(text)

        for aid, lang, note in conn.execute(
            "SELECT attribution_id, language, note "
            "FROM library_attribution_notes "
            "ORDER BY attribution_id, language"
        ):
            notes[(aid, lang)] = note

        for aid, ref_kind, target_id, language, _position in conn.execute(
            "SELECT attribution_id, ref_kind, target_id, language, position "
            "FROM library_attribution_refs "
            "ORDER BY attribution_id, position, ref_kind, target_id"
        ):
            ref: dict[str, str] = {"ref_kind": ref_kind, "target_id": target_id}
            if language:
                ref["language"] = language
            refs_map[aid].append(ref)

    # Embed set per (id, lang) = trigger phrases + note chunks (union of keys).
    embed_sets: dict[tuple[str, str], list[str]] = defaultdict(list)
    for key, texts in triggers.items():
        embed_sets[key].extend(texts)
    for key, note in notes.items():
        embed_sets[key].extend(split_into_chunks(note))
    for v in embed_sets.values():
        v.sort()
    return attrs, dict(embed_sets), dict(refs_map), notes


def _etag(texts: list[str]) -> str:
    body = "\n---\n".join(texts)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


async def run_once_attribution(settings: Settings | None = None) -> dict:
    """One attribution indexing pass — diff, embed changed, upsert, GC."""
    s = settings or get_settings()

    if not s.library_db_path.exists():
        log.info("attribution_index_skip", reason="no_library_db")
        return {"items_total": 0, "items_changed": 0, "embeddings_total": 0}

    embedder = get_embedder(s)
    # Per-dim destination table for attribution embeddings (migration 0030).
    router = EmbeddingTableRouter(dim=s.embed_dim)
    pool = get_pool()

    t0 = time.monotonic()
    attrs, embed_sets, refs_map, notes_map = _walk_attributions(s.library_db_path)

    items_total = len(embed_sets)
    log.info(
        "attribution_walk_complete",
        attributions_total=len(attrs),
        items_total=items_total,
        embed_model=embedder.name,
    )

    # Load existing etag hashes for diff.
    async with pool.acquire() as conn:
        indexed = await conn.fetch(
            "SELECT item_id, lang, etag FROM indexed_items "
            "WHERE item_kind = $1 AND embed_model = $2",
            INDEXED_KIND_ATTRIBUTION, embedder.name,
        )
    indexed_hash = {(r["item_id"], r["lang"]): r["etag"] for r in indexed}

    # Detect changed (id, lang) pairs.
    changed: list[tuple[tuple[str, str], list[str], str]] = []
    for (aid, lang), texts in embed_sets.items():
        # Dedup on the off-chance SQLite has duplicates (PK normally prevents
        # this, but guard against future schema drift). A trigger phrase that
        # equals a note chunk collapses to one row here.
        deduped = sorted(set(texts))
        h = _etag(deduped)
        if indexed_hash.get((aid, lang)) != h:
            changed.append(((aid, lang), deduped, h))

    # GC pass 1: (id, lang) pairs that vanished from library.db
    current_pairs = set(embed_sets.keys())
    stale_pairs = [k for k in indexed_hash if k not in current_pairs]

    # GC pass 2: attribution_id orphans (whole attribution removed)
    async with pool.acquire() as conn:
        pg_ids = {r["id"] for r in await conn.fetch("SELECT id FROM attributions")}
    lib_ids = set(attrs.keys())
    removed_ids = pg_ids - lib_ids

    log.info(
        "attribution_diff",
        items_changed=len(changed),
        stale_pairs=len(stale_pairs),
        orphan_attributions=len(removed_ids),
    )

    # Step A: ALWAYS upsert attributions (kind + refs). Cheap, idempotent, and
    # required so refs changes (which don't touch text) reach the chat.
    if attrs:
        async with pool.acquire() as conn:
            await conn.executemany(
                """
                INSERT INTO attributions (id, kind, refs, updated_at)
                VALUES ($1, $2, $3::jsonb, NOW())
                ON CONFLICT (id) DO UPDATE
                SET kind = EXCLUDED.kind,
                    refs = EXCLUDED.refs,
                    updated_at = NOW()
                """,
                [
                    (aid, kind, json.dumps(refs_map.get(aid, []), sort_keys=True, ensure_ascii=False))
                    for aid, kind in attrs.items()
                ],
            )

    # Step A2: mirror memory notes (full text, for injection-time fetch). Notes
    # are small and not embedded here (their chunks ride in `embed_sets`), so
    # just upsert the current set and delete any that vanished while their
    # attribution stayed (orphan attributions cascade their notes in Step D).
    async with pool.acquire() as conn:
        existing_note_keys = {
            (r["attribution_id"], r["language"])
            for r in await conn.fetch("SELECT attribution_id, language FROM attribution_notes")
        }
    if notes_map:
        async with pool.acquire() as conn:
            await conn.executemany(
                """
                INSERT INTO attribution_notes (attribution_id, language, note, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (attribution_id, language) DO UPDATE
                SET note = EXCLUDED.note, updated_at = NOW()
                """,
                [(aid, lang, note) for (aid, lang), note in notes_map.items()],
            )
    stale_notes = [
        k for k in existing_note_keys
        if k not in notes_map and k[0] not in removed_ids
    ]
    if stale_notes:
        async with pool.acquire() as conn:
            await conn.executemany(
                "DELETE FROM attribution_notes WHERE attribution_id = $1 AND language = $2",
                stale_notes,
            )

    # Step B: for each changed (id, lang), replace-all embeddings.
    embeddings_total = 0
    for (aid, lang), texts, h in changed:
        vectors = await embedder.embed_documents(texts)
        if len(vectors) != len(texts):
            raise RuntimeError(
                f"embedder returned {len(vectors)} vectors for {len(texts)} texts"
            )
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Cascading delete on parent → FK CASCADE on the per-dim
                # child table removes the matching d{N} rows automatically.
                await conn.execute(
                    """
                    DELETE FROM attribution_embeddings
                    WHERE attribution_id = $1 AND language = $2 AND embed_model = $3
                    """,
                    aid, lang, embedder.name,
                )
                # Parent row first (metadata only since 0030 dropped the
                # `embedding` column from attribution_embeddings); then
                # the child d{N} row carrying the actual vector.
                await conn.executemany(
                    """
                    INSERT INTO attribution_embeddings
                      (attribution_id, language, text, embed_model)
                    VALUES ($1, $2, $3, $4)
                    """,
                    [(aid, lang, t, embedder.name) for t in texts],
                )
                await conn.executemany(
                    f"""
                    INSERT INTO {router.attribution_table}
                      (attribution_id, language, text, embed_model, embedding)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    [(aid, lang, t, embedder.name, v) for t, v in zip(texts, vectors, strict=True)],
                )
                await conn.execute(
                    """
                    INSERT INTO indexed_items
                      (item_kind, item_id, lang, embed_model, etag, indexed_at)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                    ON CONFLICT (item_kind, item_id, lang, embed_model)
                    DO UPDATE SET etag = $5, indexed_at = NOW()
                    """,
                    INDEXED_KIND_ATTRIBUTION, aid, lang, embedder.name, h,
                )
        embeddings_total += len(texts)

    # Step C: GC stale (id, lang) pairs.
    if stale_pairs:
        async with pool.acquire() as conn:
            await conn.executemany(
                """
                DELETE FROM attribution_embeddings
                WHERE attribution_id = $1 AND language = $2 AND embed_model = $3
                """,
                [(aid, lang, embedder.name) for (aid, lang) in stale_pairs],
            )
            await conn.executemany(
                """
                DELETE FROM indexed_items
                WHERE item_kind = $1 AND item_id = $2 AND lang = $3 AND embed_model = $4
                """,
                [(INDEXED_KIND_ATTRIBUTION, aid, lang, embedder.name) for (aid, lang) in stale_pairs],
            )

    # Step D: GC orphan attribution rows. FK CASCADE handles embeddings;
    # indexed_items is not FK-linked, so clean it manually.
    if removed_ids:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM attributions WHERE id = ANY($1::text[])",
                list(removed_ids),
            )
            await conn.execute(
                """
                DELETE FROM indexed_items
                WHERE item_kind = $1 AND item_id = ANY($2::text[])
                """,
                INDEXED_KIND_ATTRIBUTION, list(removed_ids),
            )

    log.info(
        "attribution_index_complete",
        attributions_total=len(attrs),
        items_changed=len(changed),
        embeddings_written=embeddings_total,
        notes_total=len(notes_map),
        stale_pairs_removed=len(stale_pairs),
        orphan_attributions_removed=len(removed_ids),
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return {
        "items_total": items_total,
        "items_changed": len(changed),
        "embeddings_total": embeddings_total,
    }
