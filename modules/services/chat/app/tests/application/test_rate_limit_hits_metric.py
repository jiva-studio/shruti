"""Tests for the `rate_limit_hits_counter` Prometheus metric.

Counter fires whenever the application-layer rate limiter rejects a
request with 429 (user-quota OR ip-quota cap hit). Caddy proxy 429s
are NOT counted here — they go through Caddy's own access log.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pytest

from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.rate_limit_store import CounterRecord
from lectorium_chat.observability.metrics import rate_limit_hits_counter


@dataclass
class _OverLimitStore:
    """`increment` returns a count above the limit so the limiter
    routes through `reject()` and exercises the counter increment."""

    over_by: int = 1

    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        return CounterRecord(
            key_type=key_type, count=limit + self.over_by, limit=limit,
        )


def _settings() -> Settings:
    return Settings(
        database_url="postgres://test",
        s3_bucket="x",
        s3_region="us-east-1",
    )


def _counter_value(*, scope: str, key_type: str, tier: str) -> float:
    metric = rate_limit_hits_counter.labels(
        scope=scope, key_type=key_type, tier=tier,
    )
    return metric._value.get()  # type: ignore[attr-defined]


@pytest.fixture
def over_limiter() -> RateLimiter:
    return RateLimiter(store=_OverLimitStore(), settings=_settings())


async def test_counter_increments_on_user_cap_hit(over_limiter):
    """Per-user cap exceeded → counter increment with key_type=user."""
    before = _counter_value(scope="chat", key_type="user", tier="free")
    rl = await over_limiter.check_and_increment(
        "u-free-1", anonymous=False, ip="1.1.1.1",
        scope="chat", tier="free",
    )
    assert rl.allowed is False
    assert rl.key_type == "user"
    assert _counter_value(scope="chat", key_type="user", tier="free") == before + 1


async def test_counter_increments_with_anonymous_tier_label(over_limiter):
    """Anonymous JWT → echoed_tier='anonymous' regardless of underlying
    tier — counter must reflect the EFFECTIVE tier the user gets, not
    the raw claim. Matches the 429 response body the mobile UX keys off."""
    before = _counter_value(
        scope="chat", key_type="user", tier="anonymous",
    )
    await over_limiter.check_and_increment(
        "u-anon", anonymous=True, ip="2.2.2.2",
        scope="chat", tier="free",
    )
    assert _counter_value(
        scope="chat", key_type="user", tier="anonymous",
    ) == before + 1


async def test_counter_per_scope_isolation(over_limiter):
    """A title-scope hit doesn't show up under chat-scope and vice
    versa — Grafana panels can split by scope safely."""
    chat_before = _counter_value(scope="chat", key_type="user", tier="free")
    title_before = _counter_value(scope="title", key_type="user", tier="free")
    await over_limiter.check_and_increment(
        "u-1", anonymous=False, ip="3.3.3.3",
        scope="title", tier="free",
    )
    # Title incremented, chat didn't.
    assert _counter_value(scope="title", key_type="user", tier="free") == title_before + 1
    assert _counter_value(scope="chat", key_type="user", tier="free") == chat_before


async def test_counter_does_not_increment_on_allowed_request():
    """Under-limit request → no increment. Sanity check that we don't
    bump on every successful turn."""
    @dataclass
    class _UnderLimitStore:
        async def increment(self, *, scoped_key, key_type, limit, day):
            return CounterRecord(key_type=key_type, count=1, limit=limit)

    limiter = RateLimiter(store=_UnderLimitStore(), settings=_settings())
    before = _counter_value(scope="chat", key_type="user", tier="free")
    rl = await limiter.check_and_increment(
        "u-1", anonymous=False, ip="4.4.4.4",
        scope="chat", tier="free",
    )
    assert rl.allowed is True
    assert _counter_value(scope="chat", key_type="user", tier="free") == before
