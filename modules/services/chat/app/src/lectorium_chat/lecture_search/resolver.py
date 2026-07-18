"""`LectureSearchResolver` — ordered fallback across lecture providers.

Policy the individual adapters don't own:

- **Ordering** — providers are tried in the configured preference order
  (YouTube API → yt-dlp → SerpApi → DataForSEO), EXCEPT a provider whose
  quota is on cooldown is moved to the back (quota-aware ordering).
- **Per-provider timeout** — each `search` is wrapped in `asyncio.wait_for`
  so one slow source can't stall the turn; a timeout counts as a failure.
- **Circuit breaker** — after `_BREAKER_THRESHOLD` consecutive failures a
  provider is skipped for `_BREAKER_COOLDOWN_S` (no call attempted), so a
  hard-down source stops costing latency every turn.
- **Fallback** — the FIRST provider that returns a non-empty result wins;
  its candidates are deduped by URL and returned. If every provider is
  exhausted/empty, returns `[]`.

State (breaker counters, quota cooldowns) lives on the instance, which the
composition root builds once — so it persists across turns.
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable

from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.lecture_search.port import LectureSearchProvider, QuotaExceeded
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

# Consecutive failures before a provider's breaker opens.
_BREAKER_THRESHOLD = 3
# How long an open breaker stays open before we probe the provider again.
_BREAKER_COOLDOWN_S = 300.0
# How long a QuotaExceeded keeps a provider de-prioritised (tried last).
_QUOTA_COOLDOWN_S = 3600.0


class _ProviderState:
    """Per-provider breaker + quota bookkeeping."""

    __slots__ = ("failures", "open_until", "quota_until")

    def __init__(self) -> None:
        self.failures = 0
        self.open_until = 0.0     # breaker: skip entirely until this time
        self.quota_until = 0.0    # quota: de-prioritise until this time


class LectureSearchResolver:
    def __init__(
        self,
        providers: list[LectureSearchProvider],
        *,
        per_provider_timeout_s: float = 4.0,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._providers = list(providers)
        self._timeout_s = per_provider_timeout_s
        # Injectable clock so the breaker / quota windows are testable
        # without sleeping. Defaults to the monotonic wall clock.
        self._now = now or time.monotonic
        self._state: dict[str, _ProviderState] = {
            p.name: _ProviderState() for p in self._providers
        }

    def _st(self, name: str) -> _ProviderState:
        return self._state.setdefault(name, _ProviderState())

    def _ordered(self) -> list[LectureSearchProvider]:
        """Preference order, but quota-cooled providers sink to the back.

        Stable within each group so the configured order is preserved among
        providers with the same quota status."""
        now = self._now()
        healthy: list[LectureSearchProvider] = []
        cooled: list[LectureSearchProvider] = []
        for p in self._providers:
            (cooled if self._st(p.name).quota_until > now else healthy).append(p)
        return healthy + cooled

    def _record_success(self, name: str) -> None:
        st = self._st(name)
        st.failures = 0
        st.open_until = 0.0

    def _record_failure(self, name: str) -> None:
        st = self._st(name)
        st.failures += 1
        if st.failures >= _BREAKER_THRESHOLD:
            st.open_until = self._now() + _BREAKER_COOLDOWN_S
            log.warning("lecture_search_breaker_open", provider=name)

    async def search(self, query: str, *, limit: int = 5) -> list[Candidate]:
        """First non-empty provider wins; deduped by URL. `[]` if all miss."""
        q = (query or "").strip()
        if not q:
            return []
        now = self._now()
        for provider in self._ordered():
            name = provider.name
            st = self._st(name)
            if st.open_until > now:
                log.info("lecture_search_skip_breaker", provider=name)
                continue
            try:
                if not provider.available():
                    continue
            except Exception:  # noqa: BLE001 — a broken availability check == unusable
                self._record_failure(name)
                continue
            try:
                results = await asyncio.wait_for(
                    provider.search(q, limit=limit), timeout=self._timeout_s
                )
            except QuotaExceeded:
                # Not a hard failure — the provider works, it's just capped.
                # De-prioritise it (tried last) for the cooldown window and
                # fall through to the next source.
                self._st(name).quota_until = self._now() + _QUOTA_COOLDOWN_S
                log.info("lecture_search_quota", provider=name)
                continue
            except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
                self._record_failure(name)
                log.warning(
                    "lecture_search_provider_failed",
                    provider=name,
                    error=type(exc).__name__,
                )
                continue
            self._record_success(name)
            deduped = _dedupe_by_url(results)[:limit]
            if deduped:
                log.info(
                    "lecture_search_hit", provider=name, n=len(deduped),
                )
                return deduped
            # Empty is a valid miss — keep falling through.
        log.info("lecture_search_empty", query_chars=len(q))
        return []


def _dedupe_by_url(cands: list[Candidate]) -> list[Candidate]:
    """First-seen order, one candidate per distinct URL, dropping blanks."""
    seen: set[str] = set()
    out: list[Candidate] = []
    for c in cands:
        url = (c.url or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(c)
    return out
