"""Fixtures for the tests that talk to real infrastructure.

The gate itself (`--integration` / `SHRUTI_INTEGRATION_DB`) lives in the root
`tests/conftest.py`, because it is driven by the `needs_db` / `needs_network`
markers declared there and those can be worn by a test in any directory. A
test here is gated by what it needs, not by its directory.
"""

from __future__ import annotations

import os
from pathlib import Path

import asyncpg
import pytest

_MIGRATIONS = Path(__file__).resolve().parents[6] / "infra" / "app" / "db" / "migrations"


@pytest.fixture(scope="session")
def integration_db_url() -> str:
    url = os.environ.get("SHRUTI_INTEGRATION_DB")
    if not url:
        pytest.skip("SHRUTI_INTEGRATION_DB not set")
    return url


@pytest.fixture
async def chat_schema_url(integration_db_url: str) -> str:
    """`integration_db_url` with the schema the migrator ships.

    An empty database (a throwaway pgvector container) gets every `.up.sql`
    replayed in order; one that already has the chat tables is left alone.
    """
    conn = await asyncpg.connect(integration_db_url)
    try:
        if await conn.fetchval("SELECT to_regclass('public.chunk_meta')") is None:
            for migration in sorted(_MIGRATIONS.glob("*.up.sql")):
                await conn.execute(migration.read_text(encoding="utf-8"))
    finally:
        await conn.close()
    return integration_db_url
