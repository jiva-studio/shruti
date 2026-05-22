"""In-process LRU+TTL cache. Serves as L1 in the tiered setup and as the
sole backend for tests.

OrderedDict gives us O(1) LRU on top of dict insertion order. Each entry
stores its expiry timestamp; we evict on read (lazy) plus on size cap.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from time import monotonic
from typing import Awaitable, Callable


class MemoryKVCache:
    def __init__(self, *, max_entries: int = 10000) -> None:
        self._max = max_entries
        self._store: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> bytes | None:
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < monotonic():
                self._store.pop(key, None)
                return None
            # Touch for LRU.
            self._store.move_to_end(key)
            return value

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        expires_at = monotonic() + max(ttl_s, 0)
        async with self._lock:
            self._store[key] = (expires_at, value)
            self._store.move_to_end(key)
            while len(self._store) > self._max:
                self._store.popitem(last=False)

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
        async with self._lock:
            keys = [k for k in self._store if k.startswith(prefix)]
            for k in keys:
                del self._store[k]
            return len(keys)

    def healthy(self) -> bool:
        return True
