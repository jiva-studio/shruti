"""Catalog DB (`current.db`) bootstrap + atomic swap.

The agent's tools (resolve_*, list_tracks, get_track, chunks_search filters)
all read the catalog SQLite by opening fresh connections per call. We download
to a temp file on the same filesystem and `os.replace()` over the canonical
location — atomic at the kernel level; existing FDs continue reading the old
inode, new `connect()` calls see the new file.

Swaps are serialised in-process by `_swap_lock` and across processes by a
Postgres advisory lock: the scheduled run, a manual `/reindex` and the
cold-start bootstrap all go through `ensure_catalog`, and the one that waits
re-reads the version once the other has finished, so it skips instead of
downloading the same file again. Every download also gets its own temp file,
so no two callers ever write into the same path.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.domain.ports.cache_versions import CacheVersions
from shruti_chat.indexer import s3
from shruti_chat.indexer._swap import (
    CATALOG_SWAP_LOCK_KEY,
    advisory_swap_lock,
    download_verify_replace,
    read_table_names,
)
from shruti_chat.infra.repositories.catalog_dictionary import invalidate_dict_cache
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_swap_lock = asyncio.Lock()


async def read_current_version() -> str | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT current_version FROM db_state WHERE kind = 'catalog'"
        )


async def write_current_version(version: str) -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO db_state (kind, current_version, updated_at)
            VALUES ('catalog', $1, NOW())
            ON CONFLICT (kind) DO UPDATE SET
              current_version = EXCLUDED.current_version,
              updated_at      = NOW()
            """,
            version,
        )


async def ensure_catalog(
    settings: Settings | None = None,
    force: bool = False,
    *,
    cache_versions: CacheVersions,
) -> str | None:
    """Make sure /var/lib/chat/catalog.db is present and up to date.

    Returns the new catalog version if a swap happened, else None.
    """
    s = settings or get_settings()
    async with _swap_lock, advisory_swap_lock(
        CATALOG_SWAP_LOCK_KEY,
        dsn=s.database_url,
        wait_s=s.indexer_swap_lock_wait_s,
        command_timeout_s=s.db_command_timeout_s,
    ):
        return await _ensure_catalog_locked(s, force, cache_versions)


async def _ensure_catalog_locked(
    s: Settings, force: bool, cache_versions: CacheVersions,
) -> str | None:
    manifest = await s3.read_catalog_manifest(s)
    if not manifest:
        log.warning("catalog_manifest_empty")
        return None
    latest = max(m.version for m in manifest)
    local = await read_current_version()
    local_file_exists = s.catalog_db_path.exists()

    if not force and local == latest and local_file_exists:
        log.info("catalog_check", local_version=local, remote_version=latest, action="skip")
        return None

    log.info(
        "catalog_check",
        local_version=local,
        remote_version=latest,
        action="update" if local_file_exists else "bootstrap",
    )

    await download_verify_replace(
        download=lambda dest: s3.download_catalog(latest, dest, s),
        verify=_verify_catalog_file,
        tmp_dir=s.catalog_dir / ".tmp",
        prefix=f"catalog.{latest}.",
        target=s.catalog_db_path,
    )
    file_size_mb = s.catalog_db_path.stat().st_size / (1 << 20)
    await write_current_version(latest)
    # The file and the recorded version have both moved at this point, so a
    # failure below must not undo the swap — it is logged and the swap still
    # reported. The resolve_* dict cache is keyed by the file's stat signature
    # and misses on the new file regardless; the KV tag is re-read from
    # `db_state` on the next start.
    try:
        invalidate_dict_cache()
        # Bump the KV cache namespace version for catalog-derived entries
        # (track_meta, author_names, attr_confirm). Old keys age out by
        # TTL; we never DELETE so a half-failed swap doesn't poison the
        # cache mid-write.
        cache_versions.set_tag("catalog", latest)
    except Exception as exc:
        log.exception("catalog_cache_invalidate_failed", version=latest, error=str(exc))
    log.info(
        "catalog_swap",
        from_version=local,
        to_version=latest,
        file_size_mb=round(file_size_mb, 2),
    )
    return latest


def _verify_catalog_file(path: Path) -> None:
    """Open the freshly-downloaded SQLite and verify the schema we depend on."""
    names = read_table_names(path, ("table",))
    required = {"tracks", "track_variants", "authors", "locations", "tags",
                "sources", "track_tags", "track_references"}
    missing = required - names
    if missing:
        raise RuntimeError(f"catalog file at {path} is missing tables: {missing}")
