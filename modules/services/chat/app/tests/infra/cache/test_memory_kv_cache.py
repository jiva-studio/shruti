"""MemoryKVCache: TTL expiry, LRU eviction, get_or_set behaviour."""

from __future__ import annotations

import asyncio
from time import monotonic

import pytest

from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache


async def test_get_returns_none_on_miss():
    c = MemoryKVCache(max_entries=8)
    assert await c.get("missing") is None


async def test_set_then_get_roundtrip():
    c = MemoryKVCache(max_entries=8)
    await c.set("k", b"v", ttl_s=60)
    assert await c.get("k") == b"v"


async def test_ttl_expiry_returns_none_after_window(monkeypatch):
    c = MemoryKVCache(max_entries=8)
    await c.set("k", b"v", ttl_s=10)
    # Fast-forward by mocking monotonic.
    real = monotonic
    import shruti_chat.infra.cache.memory_kv_cache as mod
    monkeypatch.setattr(mod, "monotonic", lambda: real() + 100)
    assert await c.get("k") is None


async def test_lru_eviction_drops_oldest():
    c = MemoryKVCache(max_entries=2)
    await c.set("a", b"1", ttl_s=60)
    await c.set("b", b"2", ttl_s=60)
    # Touch `a` so `b` becomes LRU.
    await c.get("a")
    await c.set("c", b"3", ttl_s=60)
    assert await c.get("a") == b"1"
    assert await c.get("b") is None
    assert await c.get("c") == b"3"


async def test_get_or_set_calls_factory_on_miss_only():
    c = MemoryKVCache(max_entries=8)
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return b"computed"

    v1 = await c.get_or_set("k", ttl_s=60, factory=factory)
    v2 = await c.get_or_set("k", ttl_s=60, factory=factory)
    assert v1 == v2 == b"computed"
    assert calls == 1


async def test_delete_prefix_clears_matching_keys():
    c = MemoryKVCache(max_entries=16)
    await c.set("ns:a:1", b"x", ttl_s=60)
    await c.set("ns:a:2", b"y", ttl_s=60)
    await c.set("ns:b:1", b"z", ttl_s=60)
    n = await c.delete_prefix("ns:a:")
    assert n == 2
    assert await c.get("ns:a:1") is None
    assert await c.get("ns:b:1") == b"z"


async def test_healthy_is_always_true_for_memory():
    c = MemoryKVCache()
    assert c.healthy() is True
