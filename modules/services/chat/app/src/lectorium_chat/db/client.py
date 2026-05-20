"""Postgres async client. Single asyncpg pool, registered for pgvector codec."""

from __future__ import annotations

import asyncpg
from pgvector.asyncpg import register_vector

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    await register_vector(conn)
    # Note: `SET hnsw.iterative_scan = relaxed_order` is applied at the
    # query level via `SET LOCAL` inside the search methods, not here.
    # Session-level SET in asyncpg pool init didn't reliably propagate
    # to lazy-created connections; SET LOCAL inside an explicit
    # transaction is more robust and self-documents which queries
    # require it. See pg_chunk_repository.search_by_embedding /
    # search_library_by_embedding for the actual sites.


async def init_pool(settings: Settings | None = None) -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    s = settings or get_settings()
    # asyncpg expects postgres:// not postgresql://; accept both
    dsn = s.database_url.replace("postgresql://", "postgres://", 1)

    # Ensure pgvector extension exists BEFORE the pool registers its codec.
    # register_vector() introspects pg_type for `vector`, which fails if the
    # extension hasn't been created yet.
    bootstrap = await asyncpg.connect(dsn=dsn)
    try:
        await bootstrap.execute("CREATE EXTENSION IF NOT EXISTS vector")
    finally:
        await bootstrap.close()

    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=10,
        init=_init_connection,
    )
    log.info("db_pool_ready", min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool not initialized; call init_pool() first")
    return _pool
