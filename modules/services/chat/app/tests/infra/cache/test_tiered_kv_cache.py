"""TieredKVCache: L1 + L2 composition, L1 cap propagation, degraded L2."""

from __future__ import annotations

from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache
from shruti_chat.infra.cache.tiered_kv_cache import TieredKVCache


class _StubL2:
    """Minimal L2 stand-in: dict-backed, tracks call counts."""

    def __init__(self, healthy: bool = True) -> None:
        self._store: dict[str, bytes] = {}
        self.get_calls = 0
        self.set_calls = 0
        self._healthy = healthy

    async def get(self, key: str) -> bytes | None:
        self.get_calls += 1
        if not self._healthy:
            return None
        return self._store.get(key)

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        self.set_calls += 1
        if self._healthy:
            self._store[key] = value

    async def delete_prefix(self, prefix: str) -> int:
        keys = [k for k in self._store if k.startswith(prefix)]
        for k in keys:
            del self._store[k]
        return len(keys)

    def healthy(self) -> bool:
        return self._healthy


async def test_get_falls_through_l1_to_l2():
    l1 = MemoryKVCache(max_entries=8)
    l2 = _StubL2()
    cache = TieredKVCache(l1, l2)

    await l2.set("k", b"v", ttl_s=3600)
    # L1 doesn't know it yet; first get pulls from L2 and warms L1.
    assert await cache.get("k") == b"v"
    assert l2.get_calls == 1
    # Second get hits L1, doesn't touch L2.
    assert await cache.get("k") == b"v"
    assert l2.get_calls == 1


async def test_set_writes_to_both_tiers():
    l1 = MemoryKVCache(max_entries=8)
    l2 = _StubL2()
    cache = TieredKVCache(l1, l2)
    await cache.set("k", b"v", ttl_s=3600)
    assert await l1.get("k") == b"v"
    assert await l2.get("k") == b"v"


async def test_unhealthy_l2_does_not_break_l1_reads():
    l1 = MemoryKVCache(max_entries=8)
    l2 = _StubL2(healthy=False)
    cache = TieredKVCache(l1, l2)
    await l1.set("k", b"v", ttl_s=3600)
    assert await cache.get("k") == b"v"


async def test_l1_only_when_l2_is_none():
    l1 = MemoryKVCache(max_entries=8)
    cache = TieredKVCache(l1, None)
    await cache.set("k", b"v", ttl_s=3600)
    assert await cache.get("k") == b"v"
    # delete_prefix doesn't crash without an L2.
    assert await cache.delete_prefix("k") == 1
    assert cache.healthy() is True
