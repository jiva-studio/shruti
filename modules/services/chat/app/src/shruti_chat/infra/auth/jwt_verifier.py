"""RS256 JWT verifier.

Mirrors the auth service's signing config: same algorithm, same kid,
same public key file. Loaded once at boot — the public key is small
(~450 bytes) so we just keep it in memory.

Verification surface is intentionally tight:
  - algorithms=['RS256'] — no alg=none, no HS-vs-RS confusion.
  - exp checked (default in PyJWT) — expired tokens fail.
  - We do NOT check `aud` because auth currently doesn't set it
    (https://github.com/akdasa-studios/shruti — see plan note about
    follow-up to add iss/aud). When auth starts setting it, drop the
    `audience=None` and pin to the chat service's id.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import jwt


@dataclass(frozen=True)
class VerifiedUser:
    """The subset of auth's JWT claims chat actually uses."""

    id: str           # `sub` claim — uuid string
    anonymous: bool   # `anonymous` claim — true for /auth/anonymous bootstrap


class JwtVerifyError(Exception):
    """Raised on any verification failure (expired, bad sig, missing claim)."""


class JwtVerifier:
    def __init__(self, public_key_path: Path) -> None:
        if not public_key_path.exists():
            raise FileNotFoundError(f"JWT public key not found at {public_key_path}")
        self._public_key = public_key_path.read_text(encoding="utf-8")

    def verify(self, token: str) -> VerifiedUser:
        try:
            claims = jwt.decode(
                token,
                self._public_key,
                algorithms=["RS256"],
                # auth doesn't set aud yet (follow-up task). When it does,
                # pass `audience="chat"` here and matching pin in auth.
                options={"require": ["sub", "exp"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise JwtVerifyError("token expired") from exc
        except jwt.InvalidTokenError as exc:
            raise JwtVerifyError(f"invalid token: {exc}") from exc

        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise JwtVerifyError("missing sub")
        # Auth's signer sets `anonymous` explicitly. Defaulting to True if
        # somehow absent is the safe choice (lowest quota).
        anon_raw = claims.get("anonymous", True)
        return VerifiedUser(id=sub, anonymous=bool(anon_raw))
