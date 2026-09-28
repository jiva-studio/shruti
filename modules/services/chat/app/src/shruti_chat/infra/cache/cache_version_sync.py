"""Mirror the authoritative catalog / library versions from Postgres into the
process-wide cache version tags.

`db_state` holds the version of the catalog and library snapshots currently
published. The KV cache keys every catalog- or library-derived entry on those
versions (`domain.cache_versions`), so the in-memory tags must start from the
database's values: a process that booted with the defaults would read entries
written against a different snapshot.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.domain import cache_versions
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_MIRRORED_KINDS = frozenset({"catalog", "library"})


async def refresh_cache_versions_from_db(pool: Any) -> None:
    """Copy `db_state.current_version` for catalog and library into the tags.

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
            cache_versions.set_tag(kind, str(version))
