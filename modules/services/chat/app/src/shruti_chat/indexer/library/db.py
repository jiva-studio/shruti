"""Library DB (`library.db`) bootstrap + atomic swap.

Mirrors `indexer/catalog.py` for `current.db`. The library DB is
published independently of the catalog (see `library.publish` MCP tool)
under `public/library/library.{version}.db` and advertised in
`public/config.json` under the `library.versions[]` field.

Swaps are serialised in-process by `_swap_lock` and each download gets its
own temp file, for the same reasons as the catalog swap.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.domain import cache_versions
from shruti_chat.indexer import s3
from shruti_chat.indexer._swap import download_verify_replace, read_table_names
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_swap_lock = asyncio.Lock()


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
    async with _swap_lock:
        return await _ensure_library_locked(s, force)


async def _ensure_library_locked(s: Settings, force: bool) -> str | None:
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

    await download_verify_replace(
        download=lambda dest: s3.download_library(latest, dest, s),
        verify=_verify_library_file,
        tmp_dir=s.catalog_dir / ".tmp",
        prefix=f"library.{latest}.",
        target=s.library_db_path,
    )
    file_size_mb = s.library_db_path.stat().st_size / (1 << 20)
    await write_current_version(latest)
    # Bump KV cache version segment so library-dependent namespaces
    # (pg_chunk_search, pg_lib_search, pg_window, caption) miss
    # automatically without an explicit flush. The swap has already
    # happened, so a failure here is logged rather than raised; the tag is
    # re-read from `db_state` on the next start.
    try:
        cache_versions.set_tag("library", latest)
    except Exception as exc:
        log.exception("library_cache_invalidate_failed", version=latest, error=str(exc))
    log.info(
        "library_swap",
        from_version=local,
        to_version=latest,
        file_size_mb=round(file_size_mb, 2),
    )
    return latest


def _verify_library_file(path: Path) -> None:
    """Sanity-check the freshly-downloaded library SQLite has the schema we expect.

    Views count: `library_verse_variants` exists as a backward-compat view
    over `library_verse_translations`. Reads (`SELECT language, translation ...`) work
    against either, so gate on the name being readable, not on its storage kind.
    """
    names = read_table_names(path, ("table", "view"))
    required = {"library_verses", "library_verse_variants",
                "library_documents", "library_document_variants", "library_titles"}
    missing = required - names
    if missing:
        raise RuntimeError(f"library file at {path} is missing tables: {missing}")
