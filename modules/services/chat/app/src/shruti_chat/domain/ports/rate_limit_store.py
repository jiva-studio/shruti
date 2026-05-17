"""RateLimitStore — port for per-key per-day rate-limit counters.

Concrete implementation lives in `infra/rate_limit/` and uses the
asyncpg pool; tests can swap it for an in-memory dict-based store.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol


@dataclass(frozen=True, slots=True)
class CounterRecord:
    """One bucket's atomic increment result."""

    key_type: str
    count: int
    limit: int


class RateLimitStore(Protocol):
    async def increment(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        day: date,
    ) -> CounterRecord:
        """Increment the counter for `(scoped_key, day)` and return the
        new count along with the bucket's limit. Implementations make
        the increment atomic."""
        ...
