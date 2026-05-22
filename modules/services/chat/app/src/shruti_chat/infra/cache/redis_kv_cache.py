"""Redis-backed L2 cache with a tiny circuit breaker.

Failures (TimeoutError, RedisError) are counted; after three in a row
the breaker opens for 30 seconds during which get/set are no-ops and
`healthy()` returns False. The wrapping call site sees this and falls
through to its origin factory — the application path never blocks on
a wedged Redis.
"""

from __future__ import annotations

from time import monotonic
from typing import Awaitable, Callable

from redis import asyncio as redis_async
from redis.exceptions import RedisError

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


_CIRCUIT_THRESHOLD = 3
_CIRCUIT_OPEN_S = 30.0
_OP_TIMEOUT_S = 0.2  # per-call hard cap


class RedisKVCache:
    def __init__(self, url: str) -> None:
        self._url = url
        # decode_responses=False — we cache raw bytes; encoding is the
        # caller's concern (JSON helpers handle utf-8).
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=_OP_TIMEOUT_S,
            socket_connect_timeout=_OP_TIMEOUT_S,
            # Drop dead connections rather than hand them out to callers.
            retry_on_timeout=False,
            health_check_interval=30,
        )
        self._consecutive_failures = 0
        self._open_until: float = 0.0

    # ── circuit-breaker plumbing ──────────────────────────────────────

    def healthy(self) -> bool:
        if self._open_until == 0.0:
            return True
        if monotonic() < self._open_until:
            return False
        # Window expired — half-open: let the next op probe.
        self._open_until = 0.0
        self._consecutive_failures = 0
        log.info("cache_circuit_close", backend="redis")
        return True

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if (
            self._consecutive_failures >= _CIRCUIT_THRESHOLD
            and self._open_until == 0.0
        ):
            self._open_until = monotonic() + _CIRCUIT_OPEN_S
            log.warning(
                "cache_circuit_open",
                backend="redis",
                threshold=_CIRCUIT_THRESHOLD,
                open_s=_CIRCUIT_OPEN_S,
            )

    def _record_success(self) -> None:
        if self._consecutive_failures or self._open_until:
            self._consecutive_failures = 0
            self._open_until = 0.0

    # ── KVCache protocol ──────────────────────────────────────────────

    async def get(self, key: str) -> bytes | None:
        if not self.healthy():
            return None
        try:
            value = await self._client.get(key)
            self._record_success()
            return value
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("cache_get_error", key=key[:80], error=str(exc))
            self._record_failure()
            return None

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        if not self.healthy():
            return
        try:
            await self._client.set(key, value, ex=max(ttl_s, 1))
            self._record_success()
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("cache_set_error", key=key[:80], error=str(exc))
            self._record_failure()

    async def get_or_set(
        self,
        key: str,
        *,
        ttl_s: int,
        factory: Callable[[], Awaitable[bytes]],
    ) -> bytes:
        hit = await self.get(key)
        if hit is not None:
            return hit
        value = await factory()
        await self.set(key, value, ttl_s=ttl_s)
        return value

    async def delete_prefix(self, prefix: str) -> int:
        if not self.healthy():
            return 0
        deleted = 0
        try:
            async for key in self._client.scan_iter(match=f"{prefix}*", count=500):
                await self._client.delete(key)
                deleted += 1
            self._record_success()
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("cache_delete_prefix_error", prefix=prefix[:80], error=str(exc))
            self._record_failure()
        return deleted

    async def close(self) -> None:
        try:
            await self._client.close()
        except (RedisError, TimeoutError, OSError):
            pass
