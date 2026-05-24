"""No-op IdempotencyStore.

Used when Redis isn't configured — preserves the legacy "every retry
runs again" behaviour so a dev deploy doesn't need Redis.
"""

from __future__ import annotations


class NoopIdempotencyStore:
    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        return True
