"""`RateLimiter.refund` — give back a quota unit when a turn the user was
charged for fails before delivering an answer (LLM out of credits, graph
crash). Without this, every server-side failure (e.g. the OpenRouter 402
storm seen in prod) permanently burns a unit of the user's daily quota,
so a string of outages can rate-limit a user who never got an answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import pytest

from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.config import Settings
from shruti_chat.domain.ports.rate_limit_store import (
    CounterRecord,
    RateLimitStoreUnavailable,
)


@dataclass
class _FakeStore:
    """In-memory INCR/DECR mirror of the Redis store. DECR floors at 0 and
    is a no-op on an absent (expired) key — matching `_DECR_FLOOR_ZERO`."""

    counts: dict[tuple[str, date], int] = field(default_factory=dict)

    async def increment(
        self, *, scoped_key: str, key_type: str, limit: int, day: date
    ) -> CounterRecord:
        key = (scoped_key, day)
        self.counts[key] = self.counts.get(key, 0) + 1
        return CounterRecord(key_type=key_type, count=self.counts[key], limit=limit)

    async def decrement(self, *, scoped_key: str, day: date) -> int:
        key = (scoped_key, day)
        if key not in self.counts:
            return 0
        self.counts[key] = max(0, self.counts[key] - 1)
        return self.counts[key]


@dataclass
class _FailingDecrStore(_FakeStore):
    async def decrement(self, *, scoped_key: str, day: date) -> int:
        raise RateLimitStoreUnavailable("simulated outage")


def _settings() -> Settings:
    return Settings(database_url="postgres://test", s3_bucket="x", s3_region="us-east-1")


@pytest.mark.asyncio
async def test_refund_returns_unit_to_user_bucket() -> None:
    store = _FakeStore()
    limiter = RateLimiter(store=store, settings=_settings())

    # Signed-in user: admit charges only the per-user bucket.
    res = await limiter.check_and_increment(
        "u1", anonymous=False, ip="1.2.3.4", scope="chat", tier="free", quota_id="qid"
    )
    assert res.allowed and res.current_after == 1

    after = await limiter.refund("u1", anonymous=False, ip="1.2.3.4", scope="chat", quota_id="qid")
    assert after == 0
    day = next(k[1] for k in store.counts)
    assert store.counts[("chat:user:qid", day)] == 0


@pytest.mark.asyncio
async def test_refund_anonymous_returns_both_user_and_ip_buckets() -> None:
    store = _FakeStore()
    limiter = RateLimiter(store=store, settings=_settings())

    res = await limiter.check_and_increment(
        "anon1", anonymous=True, ip="9.9.9.9", scope="chat", tier="free"
    )
    assert res.allowed
    day = next(iter(store.counts))[1]
    assert store.counts[("chat:user:anon1", day)] == 1
    assert store.counts[("chat:ip:9.9.9.9", day)] == 1

    await limiter.refund("anon1", anonymous=True, ip="9.9.9.9", scope="chat")
    assert store.counts[("chat:user:anon1", day)] == 0
    assert store.counts[("chat:ip:9.9.9.9", day)] == 0


@pytest.mark.asyncio
async def test_refund_signed_in_leaves_ip_bucket_untouched() -> None:
    store = _FakeStore()
    limiter = RateLimiter(store=store, settings=_settings())
    # Pre-seed an unrelated IP bucket; a signed-in refund must not touch it.
    res = await limiter.check_and_increment(
        "u2", anonymous=False, ip="5.5.5.5", scope="chat", tier="pro", quota_id="q2"
    )
    day = next(k[1] for k in store.counts)
    store.counts[("chat:ip:5.5.5.5", day)] = 7

    await limiter.refund("u2", anonymous=False, ip="5.5.5.5", scope="chat", quota_id="q2")
    assert store.counts[("chat:user:q2", day)] == 0
    assert store.counts[("chat:ip:5.5.5.5", day)] == 7  # untouched


@pytest.mark.asyncio
async def test_refund_is_best_effort_on_backend_outage() -> None:
    limiter = RateLimiter(store=_FailingDecrStore(), settings=_settings())
    # Must not raise; returns None when the user-bucket decrement failed.
    result = await limiter.refund("u3", anonymous=False, ip="1.1.1.1", scope="chat", quota_id="q3")
    assert result is None
