"""Per-key per-day counters in Postgres. Used by /chat to throttle.

Keys: a device_id (UUID from app) and an IP. Limits configurable via env.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone

from lectorium_chat.config import get_settings
from lectorium_chat.db.client import get_pool
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


@dataclass
class RateLimitResult:
    allowed: bool
    code: str | None = None
    retry_after: int | None = None
    current: int = 0
    limit: int = 0
    key_type: str | None = None


def _seconds_until_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    tomorrow = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # Next midnight
    tomorrow = tomorrow.replace(day=tomorrow.day) if False else tomorrow
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


async def check_and_increment(device_id: str, ip: str) -> RateLimitResult:
    s = get_settings()
    pool = get_pool()
    today = datetime.now(timezone.utc).date()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for key, key_type, limit in (
                (device_id, "device", s.device_rate_limit_per_day),
                (ip, "ip", s.ip_rate_limit_per_day),
            ):
                if not key:
                    continue
                row = await conn.fetchrow(
                    """
                    INSERT INTO usage (key, day, count) VALUES ($1, $2, 1)
                    ON CONFLICT (key, day) DO UPDATE
                        SET count = usage.count + 1
                    RETURNING count
                    """,
                    key, today,
                )
                count = row["count"]
                if count > limit:
                    log.warning(
                        "rate_limit_hit",
                        device_id=device_id,
                        key_type=key_type,
                        current=count,
                        limit=limit,
                    )
                    return RateLimitResult(
                        allowed=False,
                        code="rate_limited",
                        retry_after=_seconds_until_midnight_utc(),
                        current=count,
                        limit=limit,
                        key_type=key_type,
                    )
    return RateLimitResult(allowed=True)
