"""Two-tier cache: in-process L1 fronts a Redis L2.

L1 absorbs the hottest reads with zero network roundtrip; on L1 miss we
consult L2 and (on hit) populate L1. L1 TTL is capped well below L2 TTL
so a version bump in Redis propagates within a minute without an
explicit flush.

When L2 is unhealthy (circuit open) we still serve from L1 and bypass
the factory only when neither tier has the value.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache


_L1_TTL_CAP_S = 60


class TieredKVCache:
    def __init__(self, l1: MemoryKVCache, l2: "object | None") -> None:
        # l2 is typed loosely (object) because the protocol Import would
        # be circular at module load time; duck-typing on the methods is
        # fine — we only call .get / .set / .healthy on it.
        self._l1 = l1
        self._l2 = l2

    async def get(self, key: str) -> bytes | None:
        hit = await self._l1.get(key)
        if hit is not None:
            return hit
        if self._l2 is None:
            return None
        value = await self._l2.get(key)  # type: ignore[attr-defined]
        if value is not None:
            await self._l1.set(key, value, ttl_s=_L1_TTL_CAP_S)
        return value

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        l1_ttl = min(ttl_s, _L1_TTL_CAP_S)
        await self._l1.set(key, value, ttl_s=l1_ttl)
        if self._l2 is not None:
            await self._l2.set(key, value, ttl_s=ttl_s)  # type: ignore[attr-defined]

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
        n = await self._l1.delete_prefix(prefix)
        if self._l2 is not None:
            n += await self._l2.delete_prefix(prefix)  # type: ignore[attr-defined]
        return n

    def healthy(self) -> bool:
        if self._l2 is None:
            return True
        return self._l2.healthy()  # type: ignore[attr-defined]
