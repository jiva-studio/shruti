"""IdempotencyStore port — atomic single-shot key acquisition.

Used by `/chat` (and any other write endpoint) to bounce duplicate
client retries that share the same `Idempotency-Key` header. The
store keeps the key alive for a TTL window covering one full LLM
turn plus a safety margin; a retry that arrives inside the window
gets `acquired=False` and the caller returns 409.

The concrete impl lives in `infra/idempotency/`. Tests use a tiny
in-memory fake.
"""

from __future__ import annotations

from typing import Protocol


class IdempotencyStore(Protocol):
    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        """Atomically claim `key` for `ttl_seconds`.

        Returns True on first acquisition (the caller should proceed
        with the request). Returns False if the key already exists
        (duplicate retry within the window — the caller should reject
        with 409).

        On backing-store failure (Redis down, breaker open) implementations
        MUST return True — degrading open is the safe choice. Duplicates
        leak through during an outage, but no first-attempt is ever
        rejected for an infra reason.
        """
        ...
