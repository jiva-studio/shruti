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

from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.config import Settings
from shruti_chat.domain.ports.rate_limit_store import CounterRecord


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
        # Non-chat scopes are flat — same value for anon, free, and pro.
        (True, "free", "title", 500),
        (False, "free", "title", 500),
        (False, "pro", "title", 500),
        (True, "free", "questions", 500),
        (False, "pro", "questions", 500),
        (True, "free", "feedback", 500),
        (False, "pro", "feedback", 500),
    ],
)
def test_user_limit_for_tier_matrix(limiter, anonymous, tier, scope, expected_limit):
    assert limiter._user_limit_for(scope, anonymous, tier) == expected_limit


@pytest.mark.parametrize("scope", ["title", "questions", "feedback"])
def test_non_chat_scopes_flat_across_tiers(limiter, scope):
    """The three cheap non-chat endpoints share ONE limit per scope —
    anonymous, free, and Pro all land on the same number."""
    anon_limit = limiter._user_limit_for(scope, True, "free")
    free_limit = limiter._user_limit_for(scope, False, "free")
    pro_limit = limiter._user_limit_for(scope, False, "pro")
    assert anon_limit == free_limit == pro_limit == 500


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
    # title is flat across tiers so stale-pro coercion is a no-op there.
    assert limiter._user_limit_for("title", False, "pro", past) == 500


def test_pro_with_future_expiry_keeps_pro_limits(limiter):
    future = int(time.time()) + 3600
    assert limiter._user_limit_for("chat", False, "pro", future) == 200  # pro
    assert limiter._user_limit_for("title", False, "pro", future) == 500


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


# ─── usage-chip fields (current_after + limit_for_scope) ────────────────


@pytest.mark.asyncio
async def test_allowed_result_carries_current_after_and_limit(limiter):
    """The /chat SSE handler reads `current_after` + `limit_for_scope`
    off the allowed result to emit the per-turn `usage` chip event.
    Both must be populated even on the happy path."""
    rl = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
    )
    assert rl.allowed
    assert rl.current_after == 1
    assert rl.limit_for_scope == 10
    rl2 = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
    )
    assert rl2.current_after == 2
    assert rl2.limit_for_scope == 10


@pytest.mark.asyncio
async def test_rejected_result_carries_current_after_and_limit(limiter):
    """On a user-key reject the chip hydrates from the 429 body, so the
    same two fields must populate on the rejected path as well."""
    for _ in range(10):
        await limiter.check_and_increment(
            "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
        )
    rl = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="1.2.3.4", scope="chat", tier="free",
    )
    assert not rl.allowed
    assert rl.key_type == "user"
    assert rl.current_after == 11  # the over-the-limit attempt
    assert rl.limit_for_scope == 10


@pytest.mark.asyncio
async def test_feedback_scope_flat_anonymous_equals_pro(limiter):
    """The plan-1 collapse: anon vs Pro on /feedback land on the SAME
    limit — flat 500 — instead of the legacy 30 / 2000 split."""
    # Anonymous user: 500th call still allowed.
    for _ in range(499):
        rl = await limiter.check_and_increment(
            "u-anon", anonymous=True, ip="9.9.9.9",
            scope="feedback", tier="free",
        )
        assert rl.allowed
    rl = await limiter.check_and_increment(
        "u-anon", anonymous=True, ip="9.9.9.9",
        scope="feedback", tier="free",
    )
    assert rl.allowed
    assert rl.limit_for_scope == 500
    # Pro user gets the same flat limit, not the old 2000.
    rl_pro = await limiter.check_and_increment(
        "u-pro", anonymous=False, ip="9.9.9.10",
        scope="feedback", tier="pro",
    )
    assert rl_pro.limit_for_scope == 500


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


# ─── per-IP cap is anonymous-only (CGNAT relief) ─────────────────────────


@pytest.mark.asyncio
async def test_signed_in_users_skip_ip_cap(limiter):
    # ip_rate_limit_per_day defaults to 2000 — at 11 Pro users on one
    # shared IP that's 2200 chats theoretically reachable, so without
    # the skip the IP cap would clip the last few before any of them
    # hit their personal 200. With the skip the cap simply doesn't
    # apply to signed-in JWTs, so we drive far past 2000 from
    # quota-distinct signed-in users and nobody trips the ip-key cap.
    for i in range(2500):
        rl = await limiter.check_and_increment(
            f"user-{i}", anonymous=False, ip="10.0.0.1",
            scope="chat", tier="pro", quota_id=f"q-{i}",
        )
        # Each user is on their first chat — well below the Pro 200/day
        # personal cap — so the only way they'd reject is the IP cap.
        # Which we've just turned off for signed-in.
        assert rl.allowed, (
            f"signed-in user #{i} on shared IP should not be IP-capped"
        )


@pytest.mark.asyncio
async def test_anonymous_users_still_bottled_by_ip_cap(limiter):
    # The IP cap is the only thing standing between an attacker's
    # botnet (minting throwaway anon JWTs from one IP) and unbounded
    # chat calls. Keep that fence: drive the IP counter past 2000
    # using quota-distinct anon identities (so the per-user cap of 3
    # never fires) and confirm the last call rejects with key_type=ip.
    for i in range(2000):
        rl = await limiter.check_and_increment(
            f"u-anon-{i}", anonymous=True, ip="10.0.0.2",
            scope="chat", tier="free", quota_id=f"anon-q-{i}",
        )
        assert rl.allowed, f"call {i} unexpectedly rejected: {rl}"
    # The 2001st request exceeds ip_rate_limit_per_day=2000 → IP reject.
    rl = await limiter.check_and_increment(
        "u-anon-overflow", anonymous=True, ip="10.0.0.2",
        scope="chat", tier="free", quota_id="anon-q-overflow",
    )
    assert not rl.allowed, "anon traffic from one IP must eventually hit a cap"
    assert rl.key_type == "ip", (
        "the cap that clips an anon-spam botnet from one IP is the IP cap"
    )


@pytest.mark.asyncio
async def test_signed_in_user_cap_still_fires(limiter):
    # Skipping the IP cap for signed-in users must NOT relax the per-
    # user cap. A free signed-in user who exhausts their personal 10
    # still gets a user-key reject on call 11.
    for _ in range(10):
        rl = await limiter.check_and_increment(
            "u-free", anonymous=False, ip="10.0.0.4",
            scope="chat", tier="free", quota_id="q-free",
        )
        assert rl.allowed
    rl = await limiter.check_and_increment(
        "u-free", anonymous=False, ip="10.0.0.4",
        scope="chat", tier="free", quota_id="q-free",
    )
    assert not rl.allowed
    assert rl.key_type == "user"
