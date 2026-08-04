"""Tests for `ChatTurnRequest.effective_tier` — the stale-Pro coercion.

A JWT can carry `tier="pro"` with a `tier_expires_at` already in the past
(e.g. a dropped RevenueCat EXPIRATION webhook). Such a lapsed claim must be
treated as free BEFORE any graph gate, so it can't unlock Pro-only
capabilities like add-to-library. This mirrors the rate limiter's policy
(`application/rate_limiter._user_limit_for`).

`now` is an argument rather than a clock read, so the rule is pure and these
cases pin the boundary exactly instead of nudging a real timestamp.
"""

from __future__ import annotations

from shruti_chat.application.chat_turn_request import ChatTurnRequest


_NOW = 1_700_000_000


def _tier(tier: str, expires_at: int) -> str:
    return ChatTurnRequest(tier=tier, tier_expires_at=expires_at).effective_tier(_NOW)


def test_active_pro_stays_pro() -> None:
    assert _tier("pro", _NOW + 3600) == "pro"


def test_pro_without_expiry_claim_stays_pro() -> None:
    # 0 means "no expiry claim" (old in-flight tokens) — leave it as Pro.
    assert _tier("pro", 0) == "pro"


def test_expired_pro_is_coerced_to_free() -> None:
    assert _tier("pro", _NOW - 3600) == "free"


def test_the_expiry_instant_itself_is_still_pro() -> None:
    # Strictly-before, so a claim expiring this very second is not yet lapsed.
    assert _tier("pro", _NOW) == "pro"


def test_free_and_anon_are_left_untouched() -> None:
    assert _tier("free", 0) == "free"
    assert _tier("anon", _NOW - 10) == "anon"
    # A non-pro tier is never coerced, even with a stale expiry attached.
    assert _tier("free", _NOW - 10) == "free"
