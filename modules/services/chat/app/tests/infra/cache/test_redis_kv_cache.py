"""RedisKVCache against fakeredis. Covers basic ops + circuit breaker."""

from __future__ import annotations

import pytest

fakeredis = pytest.importorskip("fakeredis")

from lectorium_chat.infra.cache.redis_kv_cache import RedisKVCache


@pytest.fixture
def cache(monkeypatch):
    # Replace the real client construction with a fakeredis client.
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    c = RedisKVCache.__new__(RedisKVCache)
    c._url = "fake://"
    c._client = fake
    c._consecutive_failures = 0
    c._open_until = 0.0
    return c


async def test_set_get_roundtrip(cache):
    await cache.set("k", b"v", ttl_s=60)
    assert await cache.get("k") == b"v"


async def test_get_returns_none_on_miss(cache):
    assert await cache.get("nope") is None


async def test_delete_prefix_clears_matching(cache):
    await cache.set("ns:a:1", b"x", ttl_s=60)
    await cache.set("ns:a:2", b"y", ttl_s=60)
    await cache.set("ns:b:1", b"z", ttl_s=60)
    n = await cache.delete_prefix("ns:a:")
    assert n == 2
    assert await cache.get("ns:a:1") is None
    assert await cache.get("ns:b:1") == b"z"


async def test_circuit_opens_after_repeated_failures(monkeypatch):
    # Force every redis op to raise; the breaker should open after three
    # consecutive errors and short-circuit further calls.
    from redis.exceptions import RedisError

    class _Failing:
        async def get(self, *a, **kw): raise RedisError("boom")
        async def set(self, *a, **kw): raise RedisError("boom")
        def scan_iter(self, *a, **kw):
            async def gen():
                if False: yield None
            return gen()
        async def delete(self, *a, **kw): pass

    c = RedisKVCache.__new__(RedisKVCache)
    c._url = "fake://"
    c._client = _Failing()
    c._consecutive_failures = 0
    c._open_until = 0.0

    assert c.healthy() is True
    for _ in range(3):
        assert await c.get("k") is None
    # After 3 failures the breaker is open; healthy() returns False.
    assert c.healthy() is False
    # Subsequent ops are no-ops: they don't re-raise the underlying error.
    assert await c.get("k") is None
    await c.set("k", b"v", ttl_s=60)
