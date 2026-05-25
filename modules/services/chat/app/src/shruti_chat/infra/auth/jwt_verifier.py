"""RS256 JWT verifier.

Mirrors the auth service's signing config: same algorithm, accepts a
kid → public-key map so an operator can rotate signing keys without
invalidating outstanding tokens. Loaded once at boot — public keys are
small (~450 bytes each) so we just keep them in memory.

Verification surface is intentionally tight:
  - algorithms=['RS256'] — no alg=none, no HS-vs-RS confusion.
  - exp checked (default in PyJWT) — expired tokens fail.
  - Token's `kid` header is looked up in the map; missing kid falls
    back to "v1" (signer has been stamping v1 since day one).
  - We do NOT check `aud` because auth currently doesn't set it
    (follow-up task). When auth starts setting it, pass
    `audience="chat"` here and pin a matching `aud` in auth.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import jwt


@dataclass(frozen=True)
class VerifiedUser:
    """The subset of auth's JWT claims chat actually uses."""

    id: str           # `sub` claim — uuid string
    anonymous: bool   # `anonymous` claim — true for /auth/anonymous bootstrap
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


class JwtVerifyError(Exception):
    """Raised on any verification failure (expired, bad sig, missing claim)."""


class JwtVerifier:
    """Holds a kid → PEM-text map. Use `from_file` for the legacy
    single-key deploy or `from_dir` for the rotation-ready directory
    layout. The legacy `public.pem` filename inside a directory is
    mapped to kid `v1`, so adding `vN.pub.pem` files alongside upgrades
    the deploy without any renames."""

    @classmethod
    def from_file(cls, public_key_path: Path) -> "JwtVerifier":
        if not public_key_path.exists():
            raise FileNotFoundError(f"JWT public key not found at {public_key_path}")
        return cls({"v1": public_key_path.read_text(encoding="utf-8")})

    @classmethod
    def from_dir(cls, public_keys_dir: Path) -> "JwtVerifier":
        if not public_keys_dir.is_dir():
            raise FileNotFoundError(f"JWT public-keys dir not found at {public_keys_dir}")
        keys: dict[str, str] = {}
        for p in public_keys_dir.glob("*.pub.pem"):
            kid = p.name[: -len(".pub.pem")]
            keys[kid] = p.read_text(encoding="utf-8")
        legacy = public_keys_dir / "public.pem"
        if legacy.exists():
            keys["v1"] = legacy.read_text(encoding="utf-8")
        if not keys:
            raise FileNotFoundError(
                f"no public keys in {public_keys_dir} (expected public.pem or *.pub.pem)"
            )
        return cls(keys)

    def __init__(self, keys: Mapping[str, str]) -> None:
        self._keys = dict(keys)

    def verify(self, token: str) -> VerifiedUser:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as exc:
            raise JwtVerifyError(f"invalid token: {exc}") from exc
        kid = header.get("kid") or "v1"
        key = self._keys.get(kid)
        if key is None:
            raise JwtVerifyError(f"unknown kid {kid!r}")

        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                # auth doesn't set aud yet (follow-up task). When it
                # does, pass `audience="chat"` here and matching pin in
                # auth.
                options={"require": ["sub", "exp"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise JwtVerifyError("token expired") from exc
        except jwt.InvalidTokenError as exc:
            raise JwtVerifyError(f"invalid token: {exc}") from exc

        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise JwtVerifyError("missing sub")
        # Auth's signer sets `anonymous` explicitly. Defaulting to True
        # if somehow absent is the safe choice (lowest quota).
        anon_raw = claims.get("anonymous", True)
        tier_raw = claims.get("tier") or "free"
        quota_id_raw = claims.get("quota_id") or ""
        return VerifiedUser(
            id=sub,
            anonymous=bool(anon_raw),
            tier=str(tier_raw),
            quota_id=str(quota_id_raw),
        )
