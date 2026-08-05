"""Redis-backed `RateLimitStore`.

Atomic INCR + EXPIRE via Lua so a crash between the two cannot leave a
key without a TTL (which would survive day-rollover and lock the user
out). Keys are `rl:{scoped_key}:{YYYYMMDD}`; TTL is seconds-to-next-UTC-
midnight + a full-day buffer, plus ±300s jitter to spread out the
midnight expiry burst.

On Redis errors raises the port-level `RateLimitStoreUnavailable` so the
caller can decide the fail-open vs fail-closed policy per tier (PR-1b:
non-Pro fails closed with 503, Pro gracefully degrades to a process-local
brownout counter). The previous behaviour returned `CounterRecord(count=0)`,
which silently bypassed enforcement during a Redis outage.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from redis import asyncio as redis_async
from redis.exceptions import RedisError

from shruti_chat.domain.ports.rate_limit_store import (
    CounterRecord,
    RateLimitStoreUnavailable,
)
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


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

# KEYS[1]=key. Decrement only if the key still exists — an expired bucket
# must NOT be re-created at -1 (it would survive with no TTL and corrupt
# the next day's count). Floor at 0; leave the TTL untouched (the
# increment already set it). Returns the resulting count.
_DECR_FLOOR_ZERO = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local count = redis.call('DECR', KEYS[1])
if count < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return count
"""


def _seconds_until_next_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


class RedisRateLimitStore:
    def __init__(self, url: str, *, op_timeout_s: float = 0.2) -> None:
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=op_timeout_s,
            socket_connect_timeout=op_timeout_s,
            retry_on_timeout=False,
            health_check_interval=30,
        )
        self._lua = self._client.register_script(_INCR_WITH_TTL)
        self._lua_decr = self._client.register_script(_DECR_FLOOR_ZERO)

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
            raise RateLimitStoreUnavailable(str(exc)) from exc

    async def decrement(self, *, scoped_key: str, day: date) -> int:
        full_key = f"rl:{scoped_key}:{day.strftime('%Y%m%d')}"
        try:
            raw = await self._lua_decr(keys=[full_key])
            return int(raw)
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("rate_limit_redis_decr_error", err=str(exc), key=full_key)
            raise RateLimitStoreUnavailable(str(exc)) from exc

    async def ping(self) -> bool:
        """Liveness probe for `/readyz`. True if Redis answers PING,
        False on any connection/timeout error. Never raises — readiness
        checks must not 500."""
        try:
            return bool(await self._client.ping())
        except (RedisError, TimeoutError, OSError):
            return False

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass
