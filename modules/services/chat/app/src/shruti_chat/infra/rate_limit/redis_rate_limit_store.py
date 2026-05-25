"""Redis-backed `RateLimitStore`.

Atomic INCR + EXPIRE via Lua so a crash between the two cannot leave a
key without a TTL (which would survive day-rollover and lock the user
out). Keys are `rl:{scoped_key}:{YYYYMMDD}`; TTL is seconds-to-next-UTC-
midnight + a full-day buffer, plus ±300s jitter to spread out the
midnight expiry burst.

Degrades open on Redis errors — a wedged Redis must not deny legit
requests. Same trade-off as `RedisIdempotencyStore`.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from redis import asyncio as redis_async
from redis.exceptions import RedisError

from shruti_chat.domain.ports.rate_limit_store import CounterRecord
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

_OP_TIMEOUT_S = 0.2
_TTL_JITTER_S = 300

# KEYS[1]=key, ARGV[1]=ttl_seconds (str), ARGV[2]=jitter_seconds (str).
# Returns the new counter value.
_INCR_WITH_TTL = """
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) == -1 then
  local ttl = tonumber(ARGV[1])
  local jitter = tonumber(ARGV[2])
  redis.call('EXPIRE', KEYS[1], ttl + math.random(-jitter, jitter))
end
return count
"""


def _seconds_until_next_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


class RedisRateLimitStore:
    def __init__(self, url: str) -> None:
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=_OP_TIMEOUT_S,
            socket_connect_timeout=_OP_TIMEOUT_S,
            retry_on_timeout=False,
            health_check_interval=30,
        )
        self._lua = self._client.register_script(_INCR_WITH_TTL)

    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        full_key = f"rl:{scoped_key}:{day.strftime('%Y%m%d')}"
        ttl_base = _seconds_until_next_midnight_utc() + 86400
        try:
            raw = await self._lua(
                keys=[full_key],
                args=[str(ttl_base), str(_TTL_JITTER_S)],
            )
            return CounterRecord(key_type=key_type, count=int(raw), limit=limit)
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("rate_limit_redis_error", err=str(exc), key=full_key)
            return CounterRecord(key_type=key_type, count=0, limit=limit)

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass
