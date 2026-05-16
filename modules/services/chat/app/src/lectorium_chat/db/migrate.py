"""Apply schema.sql idempotently at startup."""

from __future__ import annotations

import time
from pathlib import Path

from lectorium_chat.db.client import get_pool
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

SCHEMA_FILE = Path(__file__).parent / "schema.sql"


async def apply_schema() -> None:
    sql = SCHEMA_FILE.read_text(encoding="utf-8")
    started = time.monotonic()
    pool = get_pool()
    async with pool.acquire() as conn:
        # asyncpg cannot run multi-statement scripts via prepared protocol;
        # use the simple (text) protocol via Connection.execute on a transaction.
        async with conn.transaction():
            await conn.execute(sql)
    log.info(
        "db_migrate_apply",
        migration_file=SCHEMA_FILE.name,
        duration_ms=int((time.monotonic() - started) * 1000),
    )
