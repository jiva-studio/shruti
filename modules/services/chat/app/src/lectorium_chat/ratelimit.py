"""Per-key per-day counters in Postgres. Used by /chat and /title to throttle.

Keys: a device_id (UUID from app) and an IP. Each endpoint gets its own
bucket via the `scope` parameter so /title heat doesn't drain /chat quota
and vice versa. Limits configurable via env.
"""

from __future__ import annotations

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
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


async def check_and_increment(
    device_id: str,
    ip: str,
    *,
    scope: str = "chat",
) -> RateLimitResult:
    """Increment per-day counters for `device_id` and `ip` under `scope`.

    `scope` namespaces the keys so /chat and /title don't share a bucket.
    Returns the first violation if either key exceeds its limit; otherwise
    `allowed=True`.
    """
    s = get_settings()
    pool = get_pool()
    today = datetime.now(timezone.utc).date()
    if scope == "title":
        device_limit = s.title_device_rate_limit_per_day
        ip_limit = s.title_ip_rate_limit_per_day
    else:
        device_limit = s.device_rate_limit_per_day
        ip_limit = s.ip_rate_limit_per_day
    async with pool.acquire() as conn:
        async with conn.transaction():
            for key, key_type, limit in (
                (device_id, "device", device_limit),
                (ip, "ip", ip_limit),
            ):
                if not key:
                    continue
                # Scope-namespaced row key. The `usage` table is shared but
                # rows for different endpoints never collide.
                scoped_key = f"{scope}:{key}"
                row = await conn.fetchrow(
                    """
                    INSERT INTO usage (key, day, count) VALUES ($1, $2, 1)
                    ON CONFLICT (key, day) DO UPDATE
                        SET count = usage.count + 1
                    RETURNING count
                    """,
                    scoped_key, today,
                )
                count = row["count"]
                if count > limit:
                    log.warning(
                        "rate_limit_hit",
                        scope=scope,
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
