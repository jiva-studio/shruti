"""Library DB (`library.db`) bootstrap + atomic swap.

Mirrors `indexer/catalog.py` for `current.db`. The library DB is
published independently of the catalog (see `library.publish` MCP tool)
under `public/library/library.{version}.db` and advertised in
`public/config.json` under the `library.versions[]` field.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer import s3
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


async def read_current_version() -> str | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT current_version FROM db_state WHERE kind = 'library'"
        )


async def write_current_version(version: str) -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO db_state (kind, current_version, updated_at)
            VALUES ('library', $1, NOW())
            ON CONFLICT (kind) DO UPDATE SET
              current_version = EXCLUDED.current_version,
              updated_at      = NOW()
            """,
            version,
        )


async def ensure_library(settings: Settings | None = None, force: bool = False) -> str | None:
    """Make sure `<catalog_dir>/library.db` is present and up to date.

    Returns the new version if a swap happened, else None.
    Absence of a `library` field in config.json is non-fatal — older
    deployments that haven't run `library.publish` yet just keep working
    with no library content indexed.
    """
    s = settings or get_settings()
    manifest = await s3.read_library_manifest(s)
    if not manifest:
        log.warning("library_manifest_empty")
        return None
    latest = max(m.version for m in manifest)
    local = await read_current_version()
    local_file_exists = s.library_db_path.exists()

    if not force and local == latest and local_file_exists:
        log.info("library_check", local_version=local, remote_version=latest, action="skip")
        return None

    log.info(
        "library_check",
        local_version=local,
        remote_version=latest,
        action="update" if local_file_exists else "bootstrap",
    )

    tmp_dir = s.catalog_dir / ".tmp"
    tmp_path = tmp_dir / f"library.{latest}.db"
    await s3.download_library(latest, tmp_path, s)

    _verify_library_file(tmp_path)

    os.replace(tmp_path, s.library_db_path)
    file_size_mb = s.library_db_path.stat().st_size / (1 << 20)
    await write_current_version(latest)
    # Bump KV cache version segment so library-dependent namespaces
    # (pg_chunk_search, pg_lib_search, pg_window, caption) miss
    # automatically without an explicit flush.
    try:
        from lectorium_chat.infra.cache import versions as cache_versions
        cache_versions.set_tag("library", latest)
    except Exception:
        pass
    log.info(
        "library_swap",
        from_version=local,
        to_version=latest,
        file_size_mb=round(file_size_mb, 2),
    )
    return latest


def _verify_library_file(path: Path) -> None:
    """Sanity-check the freshly-downloaded library SQLite has the schema we expect.

    Views count: the word-by-word migration promoted `library_verse_variants`
    to `library_verse_translations` and left the old name behind as a
    backward-compat view. Reads (`SELECT language, translation ...`) work
    against either, so gate on the name being readable, not on its storage kind.
    """
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")}
    required = {"library_verses", "library_verse_variants",
                "library_documents", "library_document_variants", "library_titles"}
    missing = required - names
    if missing:
        raise RuntimeError(f"library file at {path} is missing tables: {missing}")
