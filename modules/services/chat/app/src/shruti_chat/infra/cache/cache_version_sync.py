"""Mirror the authoritative catalog / library / transcripts versions from
Postgres into the process-wide cache version tags.

`db_state` holds the version of the catalog and library snapshots currently
published, and of the last transcript-chunk write. The KV cache keys every
derived entry on those versions, so the process's tags must start from the
database's values: a process that booted with the defaults would read entries
written against a different snapshot.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.domain.ports.cache_versions import CacheVersions
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_MIRRORED_KINDS = frozenset({"catalog", "library", "transcripts"})


async def refresh_cache_versions_from_db(pool: Any, versions: CacheVersions) -> None:
    """Copy `db_state.current_version` for the mirrored kinds into the tags.

    Best-effort: an unreadable `db_state` leaves the tags as they are and logs
    a warning, because every cache namespace still works on the defaults —
    it just starts cold.
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT kind, current_version FROM db_state")
    except Exception as exc:  # noqa: BLE001
        log.warning("cache_version_refresh_failed", error=str(exc))
        return
    for row in rows:
        kind = row["kind"]
        version = row["current_version"]
        if kind in _MIRRORED_KINDS and version:
            versions.set_tag(kind, str(version))
