"""PR-1b: tier-aware fail-closed behaviour when Redis is unavailable.

Verifies:

- Non-Pro tiers (anonymous, free) → result flagged
  `backend_unavailable=True`, code `rate_limit_backend_unavailable`
  (the API layer turns this into HTTP 503).
- Pro tier → process-local brownout counter is used. Requests under
  the limit are allowed; over the limit returns a normal 429 result.
- Prometheus counter `lectorium_chat_rate_limit_redis_unavailable_total`
  increments by exactly 1 per `RateLimitStoreUnavailable` occurrence,
  labelled by tier.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pytest

from lectorium_chat.application.rate_limiter import (
    RateLimiter,
    _local_brownout_counter,
)
from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.rate_limit_store import (
    CounterRecord,
    RateLimitStoreUnavailable,
)
from lectorium_chat.observability.metrics import redis_unavailable_counter


@dataclass
class _AlwaysFailingStore:
    """Every `increment` call raises `RateLimitStoreUnavailable` — the
    exact contract the real `RedisRateLimitStore` exposes when its
    backend is unreachable. Tests against this fake exercise the
    use-case's fallback paths without spinning up an actual Redis."""

    calls: int = 0

    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        self.calls += 1
        raise RateLimitStoreUnavailable("simulated outage")


def _settings() -> Settings:
    return Settings(
        database_url="postgres://test",
        s3_bucket="x",
        s3_region="us-east-1",
    )


def _counter_value(*, tier: str) -> float:
    """Read the current sample for the labelled counter. Returns 0.0
    when the label set hasn't been touched yet (Prometheus initialises
    labelled counters lazily on first `.labels(...).inc()`)."""
    metric = redis_unavailable_counter.labels(tier=tier)
    return metric._value.get()  # type: ignore[attr-defined]


@pytest.fixture
def failing_limiter() -> tuple[RateLimiter, _AlwaysFailingStore]:
    store = _AlwaysFailingStore()
    limiter = RateLimiter(store=store, settings=_settings())
    # Reset the brownout LRU between tests so leakage doesn't cause
    # ordering-dependent flakes.
    _local_brownout_counter._entries.clear()
    return limiter, store


async def test_free_tier_fails_closed_when_redis_is_down(failing_limiter):
    limiter, store = failing_limiter
    before = _counter_value(tier="free")
    rl = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="1.1.1.1",
        scope="chat", tier="free",
    )
    assert rl.allowed is False
    assert rl.backend_unavailable is True
    assert rl.code == "rate_limit_backend_unavailable"
    assert rl.tier == "free"
    assert store.calls == 1
    # Exactly one increment of the labelled counter.
    assert _counter_value(tier="free") == before + 1


async def test_anonymous_tier_fails_closed_when_redis_is_down(failing_limiter):
    limiter, _ = failing_limiter
    before = _counter_value(tier="anonymous")
    rl = await limiter.check_and_increment(
        "u-anon", anonymous=True, ip="2.2.2.2",
        scope="chat", tier="free",
    )
    assert rl.allowed is False
    assert rl.backend_unavailable is True
    # `echoed_tier` is "anonymous" when anonymous=True regardless of
    # the underlying tier claim.
    assert rl.tier == "anonymous"
    assert _counter_value(tier="anonymous") == before + 1


async def test_pro_tier_brownout_allows_under_limit(failing_limiter):
    limiter, _ = failing_limiter
    before = _counter_value(tier="pro")
    # chat_pro_per_day defaults to 200 — well above what we'll issue here.
    for i in range(5):
        rl = await limiter.check_and_increment(
            "u-pro", anonymous=False, ip="3.3.3.3",
            scope="chat", tier="pro",
        )
        assert rl.allowed is True, f"brownout should allow request {i+1} under limit"
        assert rl.backend_unavailable is False
    # Brownout short-circuits on the user-bucket failure — the IP
    # bucket isn't attempted because the store is known to be down.
    # That keeps the counter at one tick per request, matching the
    # one-outage-event-per-call interpretation.
    assert _counter_value(tier="pro") == before + 5


async def test_pro_tier_brownout_rejects_when_local_limit_exceeded(failing_limiter):
    limiter, _ = failing_limiter
    # Burn through the per-user Pro limit (chat_pro_per_day=200). The
    # 201st call must come back as a normal 429 result, not a 503 — the
    # brownout counter has decided this user is over.
    s = _settings()
    pro_limit = s.chat_pro_per_day
    for _ in range(pro_limit):
        rl = await limiter.check_and_increment(
            "u-pro-bursty", anonymous=False, ip="4.4.4.4",
            scope="chat", tier="pro",
        )
        assert rl.allowed is True
    rl = await limiter.check_and_increment(
        "u-pro-bursty", anonymous=False, ip="4.4.4.4",
        scope="chat", tier="pro",
    )
    assert rl.allowed is False
    # NOT a 503 — the limit was actually exceeded, just enforced
    # locally. `backend_unavailable` stays False so the caller raises
    # 429 with the normal `Retry-After` semantics.
    assert rl.backend_unavailable is False
    assert rl.code == "rate_limited"
    assert rl.key_type == "user"
    assert rl.current == pro_limit + 1
    assert rl.limit == pro_limit


async def test_counter_increments_match_failure_count(failing_limiter):
    """Each individual store failure (user-bucket OR ip-bucket) ticks
    the counter exactly once. Useful regression guard against a future
    refactor that swallows the second-pass exception."""
    limiter, store = failing_limiter
    before = _counter_value(tier="free")
    # Non-Pro short-circuits after the first failure (user pass) — IP
    # pass never runs because we returned the 503 sentinel already.
    await limiter.check_and_increment(
        "u", anonymous=False, ip="5.5.5.5", scope="chat", tier="free",
    )
    assert store.calls == 1
    assert _counter_value(tier="free") == before + 1
    # Second invocation: another single increment.
    await limiter.check_and_increment(
        "u2", anonymous=False, ip="5.5.5.5", scope="chat", tier="free",
    )
    assert store.calls == 2
    assert _counter_value(tier="free") == before + 2


async def test_pro_brownout_uses_independent_buckets_per_key(failing_limiter):
    """A Pro user A burning through their bucket must not affect Pro
    user B's bucket. The brownout LRU is keyed by the same
    `(scope:user:quota_id)` string the Redis store uses, so independent
    quota_ids stay independent in the fallback path too."""
    limiter, _ = failing_limiter
    s = _settings()
    pro_limit = s.chat_pro_per_day
    for _ in range(pro_limit):
        rl = await limiter.check_and_increment(
            "user-A", anonymous=False, ip="6.6.6.6",
            scope="chat", tier="pro", quota_id="quota-apple",
        )
        assert rl.allowed
    # User B comes in fresh — must not see A's count.
    rl = await limiter.check_and_increment(
        "user-B", anonymous=False, ip="7.7.7.7",
        scope="chat", tier="pro", quota_id="quota-google",
    )
    assert rl.allowed is True
