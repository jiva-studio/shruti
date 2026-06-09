"""RateLimitStore — port for per-key per-day rate-limit counters.

Concrete implementation lives in `infra/rate_limit/` and uses the
asyncpg pool; tests can swap it for an in-memory dict-based store.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol


class RateLimitStoreUnavailable(Exception):
    """The backing store could not service an increment (outage, timeout).

    Part of the port contract: implementations raise this — store-neutral,
    not tied to any one backend — and the `RateLimiter` use-case decides
    the degradation policy (Pro → process-local brownout, free/anon →
    fail-closed 503). Keeping it here is what lets the application layer
    catch it without importing a concrete infra adapter.
    """


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

    async def decrement(self, *, scoped_key: str, day: date) -> int:
        """Atomically give one unit back to `(scoped_key, day)` and return
        the new count, floored at 0. Used to refund a quota unit when a
        turn the client was charged for fails before delivering an answer
        (e.g. the LLM provider was out of credits). A no-op returning 0
        when the key has already expired. Raises
        `RateLimitStoreUnavailable` on a backend error so the caller can
        treat the refund as best-effort."""
        ...
