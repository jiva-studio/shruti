"""RS256 JWT verifier.

Single-kid (`v1`) deployment per #728: there is exactly one signing key
for the global backend, loaded from `JWT_PUBLIC_KEY_PATH`. Tokens whose
`kid` header is missing or anything other than `v1` are rejected with a
clear error — the legacy `russia-v1` keypair is retired and any token
still signed by it must force a re-signin.

Verification surface is intentionally tight:
  - algorithms=['RS256'] — no alg=none, no HS-vs-RS confusion.
  - exp checked (default in PyJWT) — expired tokens fail.
  - audience="chat" pinned — refresh tokens carry aud="auth" and must
    be rejected here. PyJWT raises InvalidAudienceError on mismatch
    and InvalidTokenError when the claim is missing entirely (the
    require=["sub","exp","aud"] options.require triggers the latter).
  - Token's `kid` header MUST be `v1`; any other value (including
    missing) is a hard reject.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import jwt

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

# Single accepted key id. Anything else is rejected at verify-time.
_ACCEPTED_KID = "v1"

# Auth signs `quota_id` as either a sha256 hex digest (64 lower-case hex
# chars) or the empty string (anonymous / pre-Phase-3 tokens). Anything
# else is malformed — likely a producer bug or token tampering — and
# must not flow into the rate-limiter key, since a garbled value would
# either fragment a user's quota across multiple buckets or collide
# with another identity's bucket.
_QUOTA_ID_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class VerifiedUser:
    """The subset of auth's JWT claims chat actually uses."""

    id: str
    anonymous: bool
    # Subscription tier mirrored from RevenueCat via the auth-side webhook.
    # Tokens minted before Phase 3 lack the claim entirely; verify() maps
    # missing/blank to "free" so the rate-limiter degrades safely.
    tier: str = "free"
    # Stable per-OAuth-identity hash auth derives from the user's earliest
    # non-device identity (sha256(provider:subject)). Used as the rate-limit
    # key for authed users so a delete+recreate cycle doesn't refresh
    # today's quota — see issue #626. Empty string for anonymous users
    # (no OAuth identity yet) and for old in-flight tokens; the limiter
    # falls back to `sub` in that case.
    quota_id: str = ""
    # UNIX-epoch (seconds) at which `tier` expires. 0 means lifetime Pro,
    # free, or an old in-flight token that pre-dates the claim. The rate
    # limiter coerces a "pro" tier whose expiry already slid into the past
    # back to free limits — defends against a dropped EXPIRATION webhook
    # leaving stale Pro until the next reconcile cycle (up to 6h).
    tier_expires_at: int = 0


class JwtVerifyError(Exception):
    """Raised on any verification failure (expired, bad sig, missing claim)."""


class JwtVerifier:
    """Single-key RS256 verifier. Constructed from one `v1` PEM file."""

    @classmethod
    def from_file(cls, public_key_path: Path) -> "JwtVerifier":
        if not public_key_path.exists():
            raise FileNotFoundError(f"JWT public key not found at {public_key_path}")
        return cls(public_key_path.read_text(encoding="utf-8"))

    def __init__(self, public_key_pem: str) -> None:
        self._key = public_key_pem

    def verify(self, token: str) -> VerifiedUser:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as exc:
            raise JwtVerifyError(f"invalid token: {exc}") from exc
        kid = header.get("kid")
        if kid != _ACCEPTED_KID:
            raise JwtVerifyError(
                f"unsupported kid {kid!r}; only {_ACCEPTED_KID!r} is accepted"
            )

        try:
            claims = jwt.decode(
                token,
                self._key,
                algorithms=["RS256"],
                # Pin audience=chat. The auth service stamps aud="chat"
                # on access tokens and aud="auth" on refresh tokens;
                # a refresh token must NEVER be accepted by chat. PyJWT
                # raises InvalidAudienceError on mismatch and a generic
                # MissingRequiredClaimError (subclass of InvalidToken)
                # when `aud` is absent.
                audience="chat",
                options={"require": ["sub", "exp", "aud"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise JwtVerifyError("token expired") from exc
        except jwt.InvalidAudienceError as exc:
            raise JwtVerifyError(f"wrong audience: {exc}") from exc
        except jwt.InvalidTokenError as exc:
            raise JwtVerifyError(f"invalid token: {exc}") from exc

        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise JwtVerifyError("missing sub")
        # Auth's signer sets `anonymous` explicitly. Defaulting to True
        # if somehow absent is the safe choice (lowest quota).
        anon_raw = claims.get("anonymous", True)
        tier_raw = claims.get("tier") or "free"
        quota_id_raw = str(claims.get("quota_id") or "")
        # Empty is the documented "no OAuth identity yet" signal; the
        # rate-limiter falls back to `sub` in that case. Anything that
        # isn't empty and isn't a 64-char hex digest is garbage — treat
        # it the same as empty so the limiter degrades to user_id rather
        # than keying on a corrupted bucket.
        if quota_id_raw and not _QUOTA_ID_RE.fullmatch(quota_id_raw):
            log.warning(
                "quota_id_invalid_format",
                sub=sub,
                quota_id_len=len(quota_id_raw),
            )
            quota_id_raw = ""
        # tier_expires_at is UNIX-epoch seconds. Missing on old in-flight
        # tokens — 0 disables the expiry check (matches lifetime / free).
        tier_exp_raw = claims.get("tier_expires_at") or 0
        try:
            tier_exp_int = int(tier_exp_raw)
        except (TypeError, ValueError):
            tier_exp_int = 0
        return VerifiedUser(
            id=sub,
            anonymous=bool(anon_raw),
            tier=str(tier_raw),
            quota_id=quota_id_raw,
            tier_expires_at=tier_exp_int,
        )
