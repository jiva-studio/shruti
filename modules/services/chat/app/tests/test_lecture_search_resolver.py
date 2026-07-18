"""Tests for `lecture_search.resolver.LectureSearchResolver`.

Covers the policy the adapters don't own: ordered fallback (first non-empty
wins), transient-failure fall-through, per-provider timeout, the circuit
breaker, quota-aware ordering, and URL dedupe.
"""

from __future__ import annotations

import asyncio

from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.lecture_search.port import QuotaExceeded
from lectorium_chat.lecture_search.resolver import LectureSearchResolver


class _FakeProvider:
    def __init__(
        self, name, *, results=None, exc=None, delay=0.0, avail=True
    ) -> None:
        self.name = name
        self._results = results or []
        self._exc = exc
        self._delay = delay
        self._avail = avail
        self.calls = 0

    def available(self) -> bool:
        return self._avail

    async def search(self, query, *, limit):
        self.calls += 1
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._exc is not None:
            raise self._exc
        return list(self._results)


def _cand(url: str, provider: str = "p") -> Candidate:
    return Candidate(url=url, title=url, provider=provider)


async def test_first_non_empty_provider_wins() -> None:
    p1 = _FakeProvider("p1", results=[])
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    p3 = _FakeProvider("p3", results=[_cand("u3")])
    r = LectureSearchResolver([p1, p2, p3])

    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]
    assert p1.calls == 1 and p2.calls == 1
    assert p3.calls == 0  # short-circuited once p2 returned


async def test_transient_failure_falls_through() -> None:
    p1 = _FakeProvider("p1", exc=RuntimeError("boom"))
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    r = LectureSearchResolver([p1, p2])

    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]
    assert p1.calls == 1 and p2.calls == 1


async def test_slow_provider_times_out_and_falls_through() -> None:
    p1 = _FakeProvider("p1", results=[_cand("u1")], delay=0.2)
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    r = LectureSearchResolver([p1, p2], per_provider_timeout_s=0.02)

    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]  # p1 timed out


async def test_unavailable_provider_is_skipped() -> None:
    p1 = _FakeProvider("p1", results=[_cand("u1")], avail=False)
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    r = LectureSearchResolver([p1, p2])

    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]
    assert p1.calls == 0  # never called — availability gate


async def test_circuit_breaker_opens_after_repeated_failures() -> None:
    clock = [1000.0]
    p1 = _FakeProvider("p1", exc=RuntimeError("down"))
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    r = LectureSearchResolver([p1, p2], now=lambda: clock[0])

    for _ in range(3):
        await r.search("q")
    assert p1.calls == 3  # three failures → breaker opens

    # Fourth call within the cooldown window: p1 is skipped entirely.
    await r.search("q")
    assert p1.calls == 3


async def test_quota_exceeded_deprioritises_provider() -> None:
    clock = [1000.0]
    p1 = _FakeProvider("p1", exc=QuotaExceeded("capped"))
    p2 = _FakeProvider("p2", results=[_cand("u2")])
    r = LectureSearchResolver([p1, p2], now=lambda: clock[0])

    # First call: p1 hits quota → de-prioritised; p2 serves.
    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]
    assert p1.calls == 1

    # Second call: p1 is now behind p2 in the order, and p2 returns first,
    # so p1 is never even reached.
    out = await r.search("q")
    assert [c.url for c in out] == ["u2"]
    assert p1.calls == 1  # unchanged — p1 sank to the back


async def test_results_deduped_by_url() -> None:
    p1 = _FakeProvider(
        "p1", results=[_cand("u1"), _cand("u1"), _cand("u2"), _cand("")]
    )
    r = LectureSearchResolver([p1])

    out = await r.search("q")
    assert [c.url for c in out] == ["u1", "u2"]


async def test_empty_query_short_circuits() -> None:
    p1 = _FakeProvider("p1", results=[_cand("u1")])
    r = LectureSearchResolver([p1])

    assert await r.search("   ") == []
    assert p1.calls == 0


async def test_all_providers_empty_returns_empty() -> None:
    p1 = _FakeProvider("p1", results=[])
    p2 = _FakeProvider("p2", results=[])
    r = LectureSearchResolver([p1, p2])

    assert await r.search("q") == []
    assert p1.calls == 1 and p2.calls == 1
