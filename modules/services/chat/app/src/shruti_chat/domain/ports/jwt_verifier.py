"""Port definition for JWT verification."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class VerifiedUser:
    """The subset of auth's JWT claims chat actually uses."""

    id: str
    anonymous: bool
    tier: str = "free"
    quota_id: str = ""


class JwtVerifierPort(Protocol):
    def verify(self, token: str) -> VerifiedUser:
        ...
