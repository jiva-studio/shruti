"""Shared 429 response shape across /chat, /title, /questions, /feedback.

The body and headers follow Stripe/GitHub conventions:

  - `Retry-After` header (RFC 6585) carries seconds until reset.
  - `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers mirror the same
    values for clients that want machine-parseable counters.
  - The JSON body carries the same fields plus `reason`, `tier`, and
    both ISO-8601 + UNIX-seconds variants of the reset boundary so
    mobile (which already has `Date.parse(iso)`) and CLI clients are
    both happy.

Mobile UX (Phase 5) keys off `reason` and `tier` to pick the right
copy + CTA per tier (anonymous → sign-in, free → buy Pro, pro →
just wait).
"""

from __future__ import annotations

from fastapi import HTTPException

from shruti_chat.application.rate_limiter import RateLimitResult


def raise_429(rl: RateLimitResult, scope: str) -> None:
    """Translate a rejected RateLimitResult into the 429 envelope."""
    detail = {
        "code": rl.code,
        "reason": "quota_exceeded",
        "scope": scope,
        "limit": rl.limit,
        "current": rl.current,
        "key_type": rl.key_type,
        "tier": rl.tier,
        "resets_at": rl.resets_at_iso,
        "resets_at_epoch": rl.resets_at_epoch,
    }
    headers = {
        "Retry-After": str(rl.retry_after or 60),
        "X-RateLimit-Limit": str(rl.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": str(rl.resets_at_epoch or ""),
    }
    raise HTTPException(status_code=429, detail=detail, headers=headers)
