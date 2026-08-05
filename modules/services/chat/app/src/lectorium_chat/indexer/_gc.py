"""Shared garbage-collection safety rails and statements for the indexer.

Both GC passes — transcripts in `run.py`, library items in `library/indexer.py`
— compute "indexed but no longer in the source listing" and delete the
difference. That is only correct when the listing is trustworthy, and only safe
when the delete stays inside its own lane.

Two hazards this module exists for:

1. **A bad listing.** A source read returning nothing (a published catalog
   without `asset_hashes` yet, a failed fetch) once wiped the whole transcript
   corpus, which is why the callers refuse to prune on an empty listing. A
   listing that comes back *partially* populated passes that guard and loses
   data the same way, so `gc_would_prune_too_much` refuses any pass that would
   remove an implausible share of what is indexed.

2. **An under-scoped delete.** The write paths scope by `embed_model` (and, for
   transcripts, `kind`) so re-indexing a track cannot touch a same-id row in
   another lane. The GC deletes did not, so retiring a public track could take
   a user's private `user_track` chunks with it. The statements here carry the
   same scope as the writes, and run both statements in one transaction: a
   crash between them leaves chunks deleted while `indexed_items` still claims
   the item is indexed, which hides it from the diff forever at zero chunks.

Leaf module — `run.py` already imports `library/indexer.py`, so this cannot
live in either. `LIBRARY_KINDS` is passed in rather than imported for the same
reason.
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence


# Refuse a pass that would drop more than this share of the indexed set.
_MAX_STALE_SHARE = 0.25

# Below this many stale items the share check is skipped: on a small corpus
# (a fresh deploy, a language with three tracks) a legitimate removal is
# trivially more than a quarter of it.
_MIN_STALE_FOR_SHARE_CHECK = 20


def gc_would_prune_too_much(stale_count: int, indexed_count: int) -> bool:
    """True when a GC pass looks like a bad source listing, not real deletions."""
    if indexed_count <= 0 or stale_count < _MIN_STALE_FOR_SHARE_CHECK:
        return False
    return stale_count / indexed_count > _MAX_STALE_SHARE


async def delete_stale_transcripts(
    pool: Any, stale: Sequence[tuple[str, str]], embed_model: str
) -> None:
    """Drop GC'd transcript chunks and their bookkeeping rows atomically."""
    rows = [(track_id, lang, embed_model) for track_id, lang in stale]
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.executemany(
                "DELETE FROM chunks WHERE track_id = $1 AND lang = $2 "
                "AND embed_model = $3 AND kind = 'track_transcript'",
                rows,
            )
            await conn.executemany(
                """
                DELETE FROM indexed_items
                WHERE item_kind = 'track_transcript'
                  AND item_id = $1 AND lang = $2 AND embed_model = $3
                """,
                rows,
            )


async def delete_stale_library_items(
    pool: Any,
    stale: Sequence[tuple[str, str]],
    embed_model: str,
    kinds: Iterable[str],
) -> None:
    """Drop GC'd library chunks and their bookkeeping rows atomically."""
    kind_list = list(kinds)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.executemany(
                "DELETE FROM chunks WHERE item_id = $1 AND lang = $2 "
                "AND embed_model = $3 AND kind = ANY($4::text[])",
                [(i, lang, embed_model, kind_list) for i, lang in stale],
            )
            await conn.executemany(
                """
                DELETE FROM indexed_items
                WHERE item_kind = ANY($1::text[])
                  AND item_id = $2 AND lang = $3 AND embed_model = $4
                """,
                [(kind_list, i, lang, embed_model) for i, lang in stale],
            )
