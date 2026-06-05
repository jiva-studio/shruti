"""`RateLimiter.store_healthy` — the readiness probe behind /readyz.

The rate-limit store is mandatory in prod, so /readyz must fail when its
backend is unreachable. `store_healthy` delegates to the store's `ping`
when present (the Redis adapter) and reports healthy for ping-less
in-memory stores (nothing external to be down).
"""

from __future__ import annotations

import pytest

from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.config import Settings


class _PingStore:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    async def ping(self) -> bool:
        return self._alive

    async def increment(self, **_kw):  # pragma: no cover - unused here
        raise AssertionError("not called")


class _NoPingStore:
    async def increment(self, **_kw):  # pragma: no cover - unused here
        raise AssertionError("not called")


def _limiter(store) -> RateLimiter:
    return RateLimiter(store=store, settings=Settings())


@pytest.mark.asyncio
async def test_store_healthy_true_when_ping_ok() -> None:
    assert await _limiter(_PingStore(alive=True)).store_healthy() is True


@pytest.mark.asyncio
async def test_store_healthy_false_when_ping_down() -> None:
    assert await _limiter(_PingStore(alive=False)).store_healthy() is False


@pytest.mark.asyncio
async def test_store_healthy_true_when_store_has_no_ping() -> None:
    """A ping-less store (in-memory / fake) has no backend to be down."""
    assert await _limiter(_NoPingStore()).store_healthy() is True
