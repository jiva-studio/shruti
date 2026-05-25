"""Boot-time check that the central migrator has applied chat's schema.

The central `migrator` compose service (golang-migrate against
infra/db/migrations/) is the sole owner of SQL migrations. Chat used to
ship its own idempotent schema.sql; that's gone. We just probe that the
expected tables exist and exit 1 with a structured message if not.

Defensive: docker-compose `service_completed_successfully` already
blocks chat from starting before the migrator exits 0. This makes
out-of-compose runs (CI mishap, `docker run …`) fail loudly with a
human-readable hint instead of spewing asyncpg errors on every request.
"""

from __future__ import annotations

import sys

from shruti_chat.db.client import get_pool
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

# Pillars of chat's data model. If `chunks` is missing, the migrator
# hasn't run; the rest are created in the same migration set so checking
# one of each surface is enough. (Rate-limit usage lives in Redis now.)
_REQUIRED_TABLES = ("chunks",)


async def assert_schema_ready() -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = ANY($1::text[])
            """,
            list(_REQUIRED_TABLES),
        )
    present = {r["table_name"] for r in rows}
    missing = [t for t in _REQUIRED_TABLES if t not in present]
    if missing:
        log.error(
            "schema_not_migrated",
            missing=missing,
            hint="run `docker compose logs migrator`",
        )
        # Force a non-zero exit. FastAPI lifespan won't complete and uvicorn
        # will fail to bind, which is exactly what we want.
        sys.exit(1)
