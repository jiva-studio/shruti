"""Unit tests for the tier-aware rate-limit matrix.

Pure logic — no DB. Uses an in-memory fake `RateLimitStore` so the
test focuses on tier resolution and the 429-result fields, not on the
INSERT-ON-CONFLICT round-trip (covered by the Redis store's own
contract).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date

import pytest

from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.rate_limit_store import CounterRecord


@dataclass
class _FakeStore:
    """Each call returns count = (previous + 1). Mirrors atomic INCR."""

    counts: dict[tuple[str, date], int]

    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        key = (scoped_key, day)
        self.counts[key] = self.counts.get(key, 0) + 1
        return CounterRecord(key_type=key_type, count=self.counts[key], limit=limit)


def _settings() -> Settings:
    # Pull defaults straight from the model — the rate-limiter uses them
    # as-is, so we don't override anything here.
    return Settings(
        database_url="postgres://test",
        s3_bucket="x",
        s3_region="us-east-1",
    )


@pytest.fixture
def limiter():
    return RateLimiter(store=_FakeStore(counts={}), settings=_settings())


@pytest.mark.parametrize(
    "anonymous,tier,scope,expected_limit",
    [
        (True, "free", "chat", 3),
        (False, "free", "chat", 10),
        (False, "pro", "chat", 200),
        # anonymous always wins — a Pro claim on an anon JWT (impossible
        # in practice) still gets the anon limit.
        (True, "pro", "chat", 3),
        # Other scopes follow the same shape.
        (True, "free", "title", 10),
        (False, "free", "title", 50),
        (False, "pro", "title", 500),
        (False, "pro", "questions", 500),
        (False, "pro", "feedback", 2000),
    ],
)
def test_user_limit_for_tier_matrix(limiter, anonymous, tier, scope, expected_limit):
    assert limiter._user_limit_for(scope, anonymous, tier) == expected_limit


@pytest.mark.asyncio
async def test_429_carries_tier_and_resets_at(limiter):
    # Burn through the free-chat limit of 10, then trip on the 11th.
    for _ in range(10):
        rec = await limiter.check_and_increment(
            "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
        )
        assert rec.allowed
    rl = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
    )
    assert not rl.allowed
    assert rl.code == "rate_limited"
    assert rl.key_type == "user"
    assert rl.tier == "free"
    assert rl.limit == 10
    assert rl.current == 11
    assert rl.resets_at_iso is not None and rl.resets_at_iso.endswith("Z")
    assert rl.resets_at_epoch is not None and rl.resets_at_epoch > 0


@pytest.mark.asyncio
async def test_429_echoes_anonymous_over_tier(limiter):
    for _ in range(3):
        await limiter.check_and_increment(
            "u-anon", anonymous=True, ip="2.2.2.2", scope="chat", tier="free",
        )
    rl = await limiter.check_and_increment(
        "u-anon", anonymous=True, ip="2.2.2.2", scope="chat", tier="free",
    )
    assert not rl.allowed
    # The mobile UX picks "Войти" copy off this — anonymous wins over
    # whatever tier the (anonymous) JWT happened to carry.
    assert rl.tier == "anonymous"


@pytest.mark.asyncio
async def test_pro_user_gets_the_big_limit(limiter):
    # Should NOT trip at 11. Spot-check a few.
    for i in range(20):
        rl = await limiter.check_and_increment(
            "u-pro", anonymous=False, ip="3.3.3.3", scope="chat", tier="pro",
        )
        assert rl.allowed, f"pro should sail past {i+1}"


# ─── quota_id (anti-abuse against delete+recreate, issue #626) ──────────


@pytest.mark.asyncio
async def test_quota_id_survives_user_id_change(limiter):
    # Simulate delete+recreate: the same OAuth identity (apple sub "abc")
    # produces the same quota_id, but auth.users.id is different on the
    # new account. With quota_id keying, the counter persists; without
    # it (the pre-#626 behaviour), it would refresh.
    quota = "sha256-of-apple-abc"
    for _ in range(10):
        await limiter.check_and_increment(
            "user-A", anonymous=False, ip="1.1.1.1",
            scope="chat", tier="free", quota_id=quota,
        )
    # User deletes, recreates with same Apple sub → fresh user_id, SAME quota_id.
    rl = await limiter.check_and_increment(
        "user-B-fresh", anonymous=False, ip="1.1.1.1",
        scope="chat", tier="free", quota_id=quota,
    )
    assert not rl.allowed, "delete+recreate should NOT refresh the counter"
    assert rl.current == 11
    assert rl.limit == 10


@pytest.mark.asyncio
async def test_different_quota_ids_are_independent(limiter):
    # Two genuinely different users (different OAuth identities) must
    # NOT share a counter. This is the inverse invariant: quota_id
    # collisions are the bug we're guarding against.
    for _ in range(10):
        await limiter.check_and_increment(
            "user-A", anonymous=False, ip="1.1.1.1",
            scope="chat", tier="free", quota_id="quota-apple",
        )
    rl = await limiter.check_and_increment(
        "user-B", anonymous=False, ip="1.1.1.1",
        scope="chat", tier="free", quota_id="quota-google",
    )
    assert rl.allowed, "different quota_ids must have separate counters"


# ─── tier_expires_at coercion (plan 1.7) ─────────────────────────────────


def test_expired_pro_falls_back_to_free_limits(limiter):
    # A "pro" claim whose tier_expires_at slid into the past must be
    # treated as free — defends against a dropped EXPIRATION webhook.
    past = int(time.time()) - 60
    assert limiter._user_limit_for("chat", False, "pro", past) == 10  # free
    assert limiter._user_limit_for("title", False, "pro", past) == 50  # free


def test_pro_with_future_expiry_keeps_pro_limits(limiter):
    future = int(time.time()) + 3600
    assert limiter._user_limit_for("chat", False, "pro", future) == 200  # pro
    assert limiter._user_limit_for("title", False, "pro", future) == 500  # pro


def test_pro_with_zero_expiry_is_lifetime(limiter):
    # tier_expires_at=0 means lifetime (or missing claim on old tokens).
    # Must NOT be coerced even though 0 < now.
    assert limiter._user_limit_for("chat", False, "pro", 0) == 200


@pytest.mark.asyncio
async def test_expired_pro_429_echoes_free_tier(limiter):
    # Burn through free limit with a stale Pro claim — the 429 body must
    # carry tier="free" so the mobile UX shows the right copy.
    past = int(time.time()) - 60
    for _ in range(10):
        await limiter.check_and_increment(
            "u-stale-pro", anonymous=False, ip="1.2.3.4",
            scope="chat", tier="pro", tier_expires_at=past,
        )
    rl = await limiter.check_and_increment(
        "u-stale-pro", anonymous=False, ip="1.2.3.4",
        scope="chat", tier="pro", tier_expires_at=past,
    )
    assert not rl.allowed
    assert rl.tier == "free"


@pytest.mark.asyncio
async def test_empty_quota_id_falls_back_to_user_id(limiter):
    # Old in-flight tokens lack the claim → quota_id is empty string.
    # The limiter must fall back to user_id so the existing behaviour
    # holds during the rollout window. Two distinct users with no
    # quota_id should have independent counters keyed by user_id.
    for _ in range(10):
        await limiter.check_and_increment(
            "user-X", anonymous=False, ip="1.1.1.1",
            scope="chat", tier="free", quota_id="",
        )
    rl = await limiter.check_and_increment(
        "user-Y", anonymous=False, ip="1.1.1.1",
        scope="chat", tier="free", quota_id="",
    )
    assert rl.allowed, "different user_ids without quota_id must stay independent"
