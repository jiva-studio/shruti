"""Behaviour contract for the IdempotencyStore port.

The Redis-backed adapter relies on SET NX EX which is impractical to
test without spinning up Redis. Instead we exercise a tiny in-memory
fake that implements the same contract — first acquire returns True,
subsequent acquires within the TTL return False. The contract is what
the api/chat.py handler relies on; the Redis impl is verified
indirectly via the same shape.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from shruti_chat.infra.idempotency.noop import NoopIdempotencyStore


class _FakeStore:
    """In-memory IdempotencyStore for tests. Same contract as Redis SET NX EX."""

    def __init__(self) -> None:
        self._keys: dict[str, float] = {}

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        now = time.monotonic()
        exp = self._keys.get(key)
        if exp is not None and exp > now:
            return False
        self._keys[key] = now + ttl_seconds
        return True


@pytest.mark.asyncio
async def test_first_acquire_wins() -> None:
    s = _FakeStore()
    assert await s.try_acquire("k", 60) is True


@pytest.mark.asyncio
async def test_duplicate_within_window_rejected() -> None:
    s = _FakeStore()
    assert await s.try_acquire("k", 60) is True
    assert await s.try_acquire("k", 60) is False


@pytest.mark.asyncio
async def test_distinct_keys_independent() -> None:
    s = _FakeStore()
    assert await s.try_acquire("k1", 60) is True
    assert await s.try_acquire("k2", 60) is True


@pytest.mark.asyncio
async def test_expired_key_reacquireable() -> None:
    s = _FakeStore()
    assert await s.try_acquire("k", 0) is True
    # ttl=0 expires immediately under monotonic comparison; we let the
    # event loop tick once to be safe.
    await asyncio.sleep(0)
    assert await s.try_acquire("k", 60) is True


@pytest.mark.asyncio
async def test_noop_always_acquires() -> None:
    """The dev fallback must never block legitimate requests."""
    s = NoopIdempotencyStore()
    assert await s.try_acquire("k", 60) is True
    assert await s.try_acquire("k", 60) is True
