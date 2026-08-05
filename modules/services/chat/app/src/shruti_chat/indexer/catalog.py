"""Catalog DB (`current.db`) bootstrap + atomic swap.

The agent's tools (resolve_*, list_tracks, get_track, chunks_search filters)
all read the catalog SQLite by opening fresh connections per call. We download
to a temp file on the same filesystem and `os.replace()` over the canonical
location — atomic at the kernel level; existing FDs continue reading the old
inode, new `connect()` calls see the new file.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer import s3
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


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


async def ensure_catalog(settings: Settings | None = None, force: bool = False) -> str | None:
    """Make sure /var/lib/chat/catalog.db is present and up to date.

    Returns the new catalog version if a swap happened, else None.
    """
    s = settings or get_settings()
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

    tmp_dir = s.catalog_dir / ".tmp"
    tmp_path = tmp_dir / f"catalog.{latest}.db"
    await s3.download_catalog(latest, tmp_path, s)

    # Quick sanity: SQLite header check + a known table read.
    _verify_catalog_file(tmp_path)

    os.replace(tmp_path, s.catalog_db_path)
    file_size_mb = s.catalog_db_path.stat().st_size / (1 << 20)
    await write_current_version(latest)
    # Drop the in-memory dict cache (resolve_*) so next call sees fresh data.
    try:
        from shruti_chat.infra.repositories.sqlite_catalog_repository import (
            invalidate_dict_cache,
        )
        invalidate_dict_cache()
    except Exception:
        pass
    # Bump the KV cache namespace version for catalog-derived entries
    # (track_meta, author_names, attr_confirm). Old keys age out by
    # TTL; we never DELETE so a half-failed swap doesn't poison the
    # cache mid-write.
    try:
        from shruti_chat.application import cache_versions
        cache_versions.set_tag("catalog", latest)
    except Exception:
        pass
    log.info(
        "catalog_swap",
        from_version=local,
        to_version=latest,
        file_size_mb=round(file_size_mb, 2),
    )
    return latest


def _verify_catalog_file(path: Path) -> None:
    """Open the freshly-downloaded SQLite and verify the schema we depend on."""
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    required = {"tracks", "track_variants", "authors", "locations", "tags",
                "sources", "track_tags", "track_references"}
    missing = required - names
    if missing:
        raise RuntimeError(f"catalog file at {path} is missing tables: {missing}")
