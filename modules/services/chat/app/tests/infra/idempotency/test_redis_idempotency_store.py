"""`RedisIdempotencyStore` against fakeredis.

`tests/test_idempotency_store.py` pins the port's *contract* against an
in-memory fake; this pins the adapter that actually runs in production —
the SET NX EX call, the `idem:` namespace, the TTL, and the deliberate
degrade-open on a wedged Redis.
"""

from __future__ import annotations

import pytest

fakeredis = pytest.importorskip("fakeredis")

from redis.exceptions import RedisError

from shruti_chat.infra.idempotency import (
    redis_idempotency_store as mod,
)
from shruti_chat.infra.idempotency.redis_idempotency_store import (
    RedisIdempotencyStore,
)


@pytest.fixture
def store(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    monkeypatch.setattr(mod.redis_async, "from_url", lambda *a, **kw: fake)
    return RedisIdempotencyStore("redis://fake")


async def test_first_acquire_wins(store) -> None:
    assert await store.try_acquire("k", 60) is True


async def test_second_acquire_loses(store) -> None:
    """The whole point: a retried POST with the same Idempotency-Key must
    not start a second turn."""
    await store.try_acquire("k", 60)
    assert await store.try_acquire("k", 60) is False


async def test_distinct_keys_are_independent(store) -> None:
    assert await store.try_acquire("k1", 60) is True
    assert await store.try_acquire("k2", 60) is True


async def test_key_is_namespaced_and_carries_the_ttl(store) -> None:
    await store.try_acquire("abc", 45)
    assert await store._client.get("idem:abc") == b"1"
    assert await store._client.ttl("idem:abc") == 45


async def test_release_frees_the_key_for_a_retry(store) -> None:
    await store.try_acquire("k", 60)
    await store.release("k")
    assert await store._client.exists("idem:k") == 0
    assert await store.try_acquire("k", 60) is True


async def test_release_of_an_unheld_key_is_a_noop(store) -> None:
    await store.release("never-acquired")


async def test_acquire_degrades_open_on_redis_error(store) -> None:
    """A wedged Redis must not deny a legitimate first request. Duplicates
    leaking through an outage is the accepted trade."""

    async def _boom(*a, **kw):
        raise RedisError("connection reset")

    store._client.set = _boom
    assert await store.try_acquire("k", 60) is True


async def test_release_swallows_redis_errors(store) -> None:
    """A failed release just lets the key expire at its TTL — it must never
    propagate into the turn's teardown path."""

    async def _boom(*a, **kw):
        raise TimeoutError("op timeout")

    store._client.delete = _boom
    await store.release("k")


async def test_close_swallows_errors(store) -> None:
    async def _boom(*a, **kw):
        raise RedisError("already closed")

    store._client.aclose = _boom
    await store.close()
