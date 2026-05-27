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

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer.embed import get_embedder
from lectorium_chat.indexer.library import db as library_db
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

INDEXED_KIND_ATTRIBUTION = "attribution"


def _walk_attributions(library_db_path: Path) -> tuple[
    dict[str, str],                            # id → kind
    dict[tuple[str, str], list[str]],          # (id, lang) → sorted texts
    dict[str, list[dict]],                     # id → refs list
]:
    """Single pass over library.db. Returns (kinds, variants, refs_map).

    Texts are sorted within each (id, lang) so the etag is stable regardless
    of SQLite row order. Refs are sorted by (position, ref_kind, target_id)
    for the same reason — refs JSONB is normalised before upsert.
    """
    attrs: dict[str, str] = {}
    variants: dict[tuple[str, str], list[str]] = defaultdict(list)
    refs_map: dict[str, list[dict]] = defaultdict(list)

    with sqlite3.connect(f"file:{library_db_path}?mode=ro", uri=True) as conn:
        for aid, kind in conn.execute("SELECT id, kind FROM library_attributions"):
            attrs[aid] = kind

        for aid, lang, text in conn.execute(
            "SELECT attribution_id, language, text "
            "FROM library_attribution_texts "
            "ORDER BY attribution_id, language, text"
        ):
            variants[(aid, lang)].append(text)

        for aid, ref_kind, target_id, _position in conn.execute(
            "SELECT attribution_id, ref_kind, target_id, position "
            "FROM library_attribution_refs "
            "ORDER BY attribution_id, position, ref_kind, target_id"
        ):
            refs_map[aid].append({"ref_kind": ref_kind, "target_id": target_id})

    # Defensive sort (SQLite ORDER BY on TEXT is deterministic but explicit is safer).
    for v in variants.values():
        v.sort()
    return attrs, dict(variants), dict(refs_map)


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
    attrs, variants, refs_map = _walk_attributions(s.library_db_path)

    items_total = len(variants)
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
    for (aid, lang), texts in variants.items():
        # Dedup on the off-chance SQLite has duplicates (PK normally prevents
        # this, but guard against future schema drift).
        deduped = sorted(set(texts))
        h = _etag(deduped)
        if indexed_hash.get((aid, lang)) != h:
            changed.append(((aid, lang), deduped, h))

    # GC pass 1: (id, lang) pairs that vanished from library.db
    current_pairs = set(variants.keys())
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
        stale_pairs_removed=len(stale_pairs),
        orphan_attributions_removed=len(removed_ids),
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return {
        "items_total": items_total,
        "items_changed": len(changed),
        "embeddings_total": embeddings_total,
    }
