"""Redis-backed IdempotencyStore — atomic SET NX with TTL.

Mirrors the open-on-failure pattern from RedisKVCache: a backing-
store error or timeout returns True (acquired), so an Idempotency-
Key gate never blocks a real first request just because Redis is
wedged. We accept that duplicates leak through during an outage —
the alternative is denying service to legit clients.
"""

from __future__ import annotations

from redis import asyncio as redis_async
from redis.exceptions import RedisError

from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)

_OP_TIMEOUT_S = 0.2  # per-call hard cap; matches RedisKVCache


class RedisIdempotencyStore:
    """SET NX EX wrapper. Single Redis op per acquire; no breaker
    state since a single failure already degrades open."""

    def __init__(self, url: str) -> None:
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=_OP_TIMEOUT_S,
            socket_connect_timeout=_OP_TIMEOUT_S,
            retry_on_timeout=False,
            health_check_interval=30,
        )

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        try:
            # SET key "1" NX EX ttl — atomic. Returns None when the key
            # already exists; returns True on first set.
            res = await self._client.set(
                name=f"idem:{key}",
                value=b"1",
                nx=True,
                ex=ttl_seconds,
            )
            return bool(res)
        except (RedisError, TimeoutError, OSError) as exc:
            # Degrade open: a wedged Redis must not deny legit requests.
            log.warning("idempotency_redis_error", err=str(exc))
            return True

    async def release(self, key: str) -> None:
        # Best-effort DEL — used to free the key after a turn that did
        # not succeed. A failed release just lets the key expire at its
        # TTL, so swallow every backing-store error.
        try:
            await self._client.delete(f"idem:{key}")
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("idempotency_release_error", err=str(exc))

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass
