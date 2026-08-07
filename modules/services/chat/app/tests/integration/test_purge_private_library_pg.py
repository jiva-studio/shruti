"""The purge, run by Postgres rather than by a fake that agrees with it.

The unit test next door mirrors the last-owner condition in Python, so it kept
passing when that condition was deleted from the statement — only an assertion
on the SQL text caught it. A DELETE that can take another person's library
with it deserves to be executed at least once, against the real tables.

Skipped unless `--integration` / `LECTORIUM_INTEGRATION_DB` is set.
"""

from __future__ import annotations

import asyncpg
import pytest

from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import PgChunkRepository


_GONE = "purge-test-owner-gone"
_STAYS = "purge-test-owner-stays"
_TRACKS = ("purge_test_solo", "purge_test_shared")


@pytest.fixture
async def seeded(integration_db_url: str):
    pool = await asyncpg.create_pool(integration_db_url, min_size=1, max_size=2)
    async with pool.acquire() as conn:
        await _clean(conn)
        for track in _TRACKS:
            await conn.execute(
                """
                INSERT INTO chunks (kind, track_id, lang, text, embed_model,
                                    start_ms, end_ms)
                VALUES ('user_track', $1, 'ru', 'x', 'test-model', 0, 1000)
                """,
                track,
            )
        await conn.execute(
            "INSERT INTO chunk_meta (owner_id, track_id) VALUES ($1,$2),($1,$3),($4,$3)",
            _GONE, _TRACKS[0], _TRACKS[1], _STAYS,
        )
    yield pool
    async with pool.acquire() as conn:
        await _clean(conn)
    await pool.close()


async def _clean(conn) -> None:
    await conn.execute(
        "DELETE FROM chunk_meta WHERE owner_id = ANY($1::text[])", [_GONE, _STAYS],
    )
    await conn.execute(
        "DELETE FROM chunks WHERE track_id = ANY($1::text[])", list(_TRACKS),
    )


async def test_postgres_keeps_the_upload_the_other_owner_still_has(seeded) -> None:
    pool = seeded
    repo = PgChunkRepository(
        pool=pool, embed_model="test-model", router=EmbeddingTableRouter(1536),
    )

    got = await repo.purge_owner(_GONE)

    assert got["meta_rows"] == 2
    assert got["chunks"] == 1, "only the upload nobody owns any more"
    async with pool.acquire() as conn:
        left = await conn.fetch(
            "SELECT track_id FROM chunks WHERE track_id = ANY($1::text[])",
            list(_TRACKS),
        )
        owners = await conn.fetch(
            "SELECT owner_id FROM chunk_meta WHERE track_id = $1", _TRACKS[1],
        )
    assert [r["track_id"] for r in left] == [_TRACKS[1]]
    assert [r["owner_id"] for r in owners] == [_STAYS]
