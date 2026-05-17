"""Postgres-backed `RateLimitStore`.

Atomic upsert on the `usage(key, day)` row — exact same SQL the old
`ratelimit.check_and_increment` ran, just hoisted behind a port.
"""

from __future__ import annotations

from datetime import date

import asyncpg

from shruti_chat.domain.ports.rate_limit_store import CounterRecord


class PgRateLimitStore:
    def __init__(self, *, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO usage (key, day, count) VALUES ($1, $2, 1)
                ON CONFLICT (key, day) DO UPDATE
                    SET count = usage.count + 1
                RETURNING count
                """,
                scoped_key, day,
            )
        return CounterRecord(
            key_type=key_type,
            count=int(row["count"]),
            limit=limit,
        )
