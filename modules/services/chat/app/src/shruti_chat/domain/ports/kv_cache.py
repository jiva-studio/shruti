"""KVCache — port for the generic key/value cache used by application
code to memoise deterministic LLM and DB calls.

The API is async because the production adapter is Redis-backed; the
in-memory adapter is async-shaped too so tests look identical.

`get_or_set` is the canonical entry point: it folds the get/miss/set/return
sequence so wrappers around LLM calls stay one-liners. `get` and `set`
exist for sites that need to write conditionally or read without the
factory plumbing.

`delete_prefix` is reserved for admin flush endpoints — not used on the
hot path. `healthy` lets the call site short-circuit when the backend
is in a circuit-open state and a synchronous bypass is cheaper than
even attempting a network roundtrip.
"""

from __future__ import annotations

from typing import Awaitable, Callable, Protocol


class KVCache(Protocol):
    async def get(self, key: str) -> bytes | None:
        """Return the cached bytes payload or None on miss."""
        ...

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        """Store `value` under `key` with a TTL in seconds."""
        ...

    async def get_or_set(
        self,
        key: str,
        *,
        ttl_s: int,
        factory: Callable[[], Awaitable[bytes]],
    ) -> bytes:
        """Return cached bytes if present; otherwise call `factory`,
        cache and return its result. Implementations should swallow
        backend errors and fall through to the factory."""
        ...

    async def delete_prefix(self, prefix: str) -> int:
        """Remove every key starting with `prefix`. Returns count deleted.
        Best-effort — used only by admin endpoints."""
        ...

    def healthy(self) -> bool:
        """Whether the backend is currently usable. False during circuit-open."""
        ...
