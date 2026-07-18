"""`LectureSearchProvider` — the port every source adapter implements.

Deliberately tiny: one async `search` plus two capability signals the
resolver reads. The resolver owns the timeout / circuit-breaker / ordering
policy, so an adapter only has to (a) say whether it's usable at all
(`available`) and (b) turn a query into a list of `Candidate`s, raising
`QuotaExceeded` when it hit a rate/quota wall (so the resolver can
de-prioritise it) or any other exception on a transient failure.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from shruti_chat.lecture_search.models import Candidate


class QuotaExceeded(Exception):
    """Raised by an adapter when the upstream signalled quota/rate exhaustion.

    The resolver treats this specially: it records a cooldown for the
    provider so subsequent turns try it LAST (quota-aware ordering) instead
    of burning the first slot on a source that's already capped.
    """


@runtime_checkable
class LectureSearchProvider(Protocol):
    """A single external lecture source (YouTube, yt-dlp, SerpApi, …)."""

    #: Stable short id used in logs, ordering config and the card `source`.
    name: str

    def available(self) -> bool:
        """True when the adapter can actually run (key present, binary
        importable, host configured). A False here makes the resolver skip
        the provider entirely without counting it as a failure."""
        ...

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        """Return up to `limit` candidates for `query`.

        MUST raise `QuotaExceeded` on a quota/rate wall so the resolver can
        de-prioritise the provider; MAY raise any other exception on a
        transient error (the resolver catches it and falls through). An
        empty list is a valid "nothing found" — NOT an error."""
        ...
