"""OutlineCache — port for storing generated lecture outlines.

The agent generates an outline once and caches it. The cache key is the
domain-level `(track_id, lang)` pair; concrete adapters mix in the
producing-model name internally so a model swap implicitly invalidates
the cache without callers thinking about it.

`put` supports a conditional mode (`if_none_match=True`) so two workers
that race on the cold path can't clobber each other — the loser sees
`OutlineCacheConflict` and refetches the winner's payload.
"""

from __future__ import annotations

from typing import Any, Protocol


class OutlineCacheConflict(Exception):
    """Raised by `put(..., if_none_match=True)` when another writer won
    the race (i.e. the key already exists)."""


class OutlineCache(Protocol):
    async def head(self, track_id: str, lang: str) -> bool:
        """Whether a cached outline exists for `(track_id, lang)`."""
        ...

    async def get(self, track_id: str, lang: str) -> dict[str, Any]:
        """Return the cached outline payload."""
        ...

    async def put(
        self,
        track_id: str,
        lang: str,
        payload: dict[str, Any],
        *,
        if_none_match: bool = False,
    ) -> None:
        """Persist the outline payload.

        With `if_none_match=True`, raises `OutlineCacheConflict` if a
        concurrent writer already stored a payload for this key — the
        caller is expected to call `get` to retrieve theirs instead of
        retrying."""
        ...
