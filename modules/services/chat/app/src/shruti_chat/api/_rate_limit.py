"""Shared 429 / 503 response shape across /chat, /title, /questions, /feedback.

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

`raise_for_rate_limit` is the unified entry point — it picks 429
(quota exceeded) vs 503 (backend unavailable) based on the result
flags so callers don't have to branch.
"""

from __future__ import annotations

from fastapi import HTTPException

from shruti_chat.application.rate_limiter import RateLimitResult


def raise_429(rl: RateLimitResult, scope: str) -> None:
    """Translate a rejected RateLimitResult into the 429 envelope.

    Routes through `raise_for_rate_limit` so callers that still invoke
    this name get 503 treatment automatically when the backend is the
    failing party (PR-1b). Kept for source-compat with existing routes.
    """
    raise_for_rate_limit(rl, scope=scope)


def raise_for_rate_limit(rl: RateLimitResult, *, scope: str) -> None:
    """Translate a rejected RateLimitResult into the right HTTP error.

    - `backend_unavailable=True` → 503 (Redis is down, decision unknown)
    - otherwise → 429 (quota actually exhausted)
    """
    if rl.backend_unavailable:
        raise HTTPException(
            status_code=503,
            detail={
                "code": rl.code or "rate_limit_backend_unavailable",
                "reason": "rate_limit_backend_unavailable",
                "scope": scope,
                "tier": rl.tier,
            },
            # 30s nudges a polite retry without thundering-herd. The
            # underlying Redis outage is normally minutes, not days.
            headers={"Retry-After": "30"},
        )
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
