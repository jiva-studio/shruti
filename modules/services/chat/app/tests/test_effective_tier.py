"""Tests for `_effective_tier` — the stale-Pro coercion in `chat_turn`.

A JWT can carry `tier="pro"` with a `tier_expires_at` already in the past
(e.g. a dropped RevenueCat EXPIRATION webhook). Such a lapsed claim must be
treated as free BEFORE any graph gate, so it can't unlock Pro-only
capabilities like add-to-library. This mirrors the rate limiter's policy
(`application/rate_limiter._user_limit_for`).
"""

from __future__ import annotations

from time import time

from lectorium_chat.application.chat_turn import _effective_tier


def test_active_pro_stays_pro() -> None:
    future = int(time()) + 3600
    assert _effective_tier("pro", future) == "pro"


def test_pro_without_expiry_claim_stays_pro() -> None:
    # 0 means "no expiry claim" (old in-flight tokens) — leave it as Pro.
    assert _effective_tier("pro", 0) == "pro"


def test_expired_pro_is_coerced_to_free() -> None:
    past = int(time()) - 3600
    assert _effective_tier("pro", past) == "free"


def test_free_and_anon_are_left_untouched() -> None:
    assert _effective_tier("free", 0) == "free"
    assert _effective_tier("anon", int(time()) - 10) == "anon"
