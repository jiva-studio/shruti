"""`RedisRateLimitStore` against fakeredis, Lua included.

The two Lua scripts are where the money is: `_INCR_WITH_TTL` decides whether
a bucket can survive the day rollover with no TTL (locking a user out), and
`_DECR_FLOOR_ZERO` decides whether a refund can resurrect an already-expired
bucket at -1 (handing out a free extra request every day after). Neither had
a test, and neither can be checked by reading the Python around it.

fakeredis runs the scripts for real when `lupa` is installed — that is why
the dev extra is `fakeredis[lua]`. Without it the whole module skips rather
than pretending to cover the scripts.
"""

from __future__ import annotations

from datetime import date

import pytest

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip(
    "lupa", reason="fakeredis needs lupa to execute the Lua scripts (fakeredis[lua])"
)

from redis.exceptions import RedisError

from lectorium_chat.domain.ports.rate_limit_store import (
    RateLimitStoreUnavailable,
)
from lectorium_chat.infra.rate_limit import redis_rate_limit_store as mod
from lectorium_chat.infra.rate_limit.redis_rate_limit_store import (
    RedisRateLimitStore,
)

DAY = date(2026, 8, 10)
KEY = "rl:user:u1:20260810"


@pytest.fixture
def store(monkeypatch):
    """A real `RedisRateLimitStore` — constructor included, so the script
    registration is exercised — talking to fakeredis."""
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    monkeypatch.setattr(mod.redis_async, "from_url", lambda *a, **kw: fake)
    return RedisRateLimitStore("redis://fake")


def _client(store) -> object:
    return store._client


async def test_increment_counts_up_within_the_day(store) -> None:
    first = await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    second = await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert (first.count, first.limit, first.key_type) == (1, 10, "user")
    assert second.count == 2


async def test_key_is_namespaced_per_day(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert await _client(store).get(KEY) == b"1"


async def test_a_new_day_starts_a_fresh_bucket(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    tomorrow = await store.increment(
        scoped_key="user:u1", key_type="user", limit=10, day=date(2026, 8, 11)
    )
    assert tomorrow.count == 1


async def test_scoped_keys_are_independent(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    other = await store.increment(scoped_key="ip:1.2.3.4", key_type="ip", limit=10, day=DAY)
    assert other.count == 1


async def test_first_increment_sets_a_jittered_ttl(store) -> None:
    """The bucket must always carry a TTL, and it must outlive the day it
    counts — seconds-to-midnight plus a full day, ±300s of jitter. The jitter
    value itself is not asserted: Redis seeds Lua's PRNG per execution, so the
    draw is not something a test can pin down."""
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    ttl = await _client(store).ttl(KEY)
    assert 86_400 - mod._TTL_JITTER_S <= ttl <= 2 * 86_400 + mod._TTL_JITTER_S


async def test_ttl_is_set_once_not_refreshed_on_every_hit(store) -> None:
    """A TTL re-applied on each increment would ratchet the window forward
    and let a burst of traffic keep yesterday's count alive indefinitely."""
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await _client(store).expire(KEY, 42)
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert await _client(store).ttl(KEY) == 42


async def test_untimed_key_gets_a_ttl_on_the_next_increment(store) -> None:
    """A key that somehow lost its TTL (crash between INCR and EXPIRE on an
    older non-atomic version) must be repaired, not left immortal."""
    await _client(store).set(KEY, b"5")
    assert await _client(store).ttl(KEY) == -1
    rec = await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert rec.count == 6
    assert await _client(store).ttl(KEY) > 0


async def test_decrement_refunds_one(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert await store.decrement(scoped_key="user:u1", day=DAY) == 1


async def test_decrement_leaves_the_ttl_alone(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await _client(store).expire(KEY, 77)
    await store.decrement(scoped_key="user:u1", day=DAY)
    assert await _client(store).ttl(KEY) == 77


async def test_decrement_does_not_resurrect_an_expired_bucket(store) -> None:
    """The refund of a request whose bucket already expired must be a no-op.
    A bare DECR would create the key at -1 with no TTL: it survives the next
    rollover and silently grants an extra request every day."""
    assert await store.decrement(scoped_key="user:u1", day=DAY) == 0
    assert await _client(store).exists(KEY) == 0


async def test_decrement_floors_at_zero_and_keeps_the_ttl(store) -> None:
    """Two refunds for one increment must not push the counter negative —
    a negative bucket is free quota for the rest of the day."""
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await _client(store).expire(KEY, 99)
    assert await store.decrement(scoped_key="user:u1", day=DAY) == 0
    assert await store.decrement(scoped_key="user:u1", day=DAY) == 0
    assert await _client(store).get(KEY) == b"0"
    assert await _client(store).ttl(KEY) == 99


async def test_refunded_bucket_still_counts_up_afterwards(store) -> None:
    await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    await store.decrement(scoped_key="user:u1", day=DAY)
    rec = await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)
    assert rec.count == 1


async def test_increment_raises_store_unavailable_on_redis_error(store) -> None:
    """The port contract the caller's fail-open/fail-closed policy hangs on.
    Returning a zero count here (the pre-#PR-1b behaviour) bypassed the limit
    entirely during an outage."""

    async def _boom(*a, **kw):
        raise RedisError("connection reset")

    store._lua = _boom
    with pytest.raises(RateLimitStoreUnavailable):
        await store.increment(scoped_key="user:u1", key_type="user", limit=10, day=DAY)


async def test_decrement_raises_store_unavailable_on_redis_error(store) -> None:
    async def _boom(*a, **kw):
        raise TimeoutError("op timeout")

    store._lua_decr = _boom
    with pytest.raises(RateLimitStoreUnavailable):
        await store.decrement(scoped_key="user:u1", day=DAY)


async def test_ping_is_true_when_redis_answers(store) -> None:
    assert await store.ping() is True


async def test_ping_is_false_and_never_raises_on_error(store) -> None:
    """`/readyz` calls this — an unreachable Redis must read as not-ready,
    not as a 500."""

    async def _boom(*a, **kw):
        raise RedisError("down")

    store._client.ping = _boom
    assert await store.ping() is False


async def test_close_swallows_errors(store) -> None:
    async def _boom(*a, **kw):
        raise RedisError("already closed")

    store._client.aclose = _boom
    await store.close()
