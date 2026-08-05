"""The cross-replica cancel flag must not be read once per token.

`is_cancelled` runs after every streamed event, including every `delta`. It
checks the in-process cancel event first, then falls through to the turn
store — which for the Redis adapter is one `EXISTS` per call. Unthrottled,
a 1500-token answer meant 1500 round-trips to the instance that also holds
the KV cache, the rate-limit counters, the idempotency keys and the turn
buffers, behind a 0.2s socket timeout.

The in-process event stays checked on every call, so an explicit Stop that
lands on this replica — every Stop on a single-replica deploy — is unaffected.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.application import turn_runner as turn_runner_mod
from lectorium_chat.application.turn_runner import TurnRunner


class _CountingStore:
    """TurnStore that counts cross-replica cancel reads."""

    def __init__(self) -> None:
        self.is_cancelled_calls = 0
        self.cancelled: set[str] = set()

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(
        self, trace_id: str, *, state: str, events: list[dict[str, Any]], user_id: str
    ) -> None:
        return None

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return None

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        self.is_cancelled_calls += 1
        return trace_id in self.cancelled


async def _capture_predicate(runner: TurnRunner, trace_id: str = "t-1"):
    """Run a turn with an empty stream and hand back its cancel predicate."""
    captured: dict[str, Any] = {}

    def factory(is_cancelled):
        captured["fn"] = is_cancelled

        async def _empty():
            return
            yield  # pragma: no cover — makes this an async generator

        return _empty()

    async def finalize(had_error: bool, completed: bool, answer_started: bool):
        return None

    queue = runner.start(trace_id, "user-1", stream_factory=factory, finalize=finalize)
    while await queue.get() is not None:
        pass
    return captured["fn"]


def _advance(clock: dict[str, float]) -> None:
    """Step past the throttle window. `produce()` polls once itself when the
    stream drains, so the predicate handed back is already armed."""
    clock["t"] += turn_runner_mod._CANCEL_POLL_INTERVAL_S + 0.01


async def test_a_burst_of_events_costs_one_remote_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"t": 100.0}
    monkeypatch.setattr(turn_runner_mod, "monotonic", lambda: clock["t"])
    store = _CountingStore()
    is_cancelled = await _capture_predicate(TurnRunner(store))

    _advance(clock)
    before = store.is_cancelled_calls
    for _ in range(500):
        assert await is_cancelled() is False

    # 500 streamed tokens inside one window → a single remote read.
    assert store.is_cancelled_calls - before == 1


async def test_the_flag_is_re_read_after_the_interval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"t": 100.0}
    monkeypatch.setattr(turn_runner_mod, "monotonic", lambda: clock["t"])
    store = _CountingStore()
    is_cancelled = await _capture_predicate(TurnRunner(store))

    _advance(clock)
    before = store.is_cancelled_calls
    await is_cancelled()
    _advance(clock)
    await is_cancelled()

    assert store.is_cancelled_calls - before == 2


async def test_a_remote_stop_is_still_observed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"t": 100.0}
    monkeypatch.setattr(turn_runner_mod, "monotonic", lambda: clock["t"])
    store = _CountingStore()
    is_cancelled = await _capture_predicate(TurnRunner(store), trace_id="t-remote")

    await is_cancelled()
    # Another replica sets the flag; this one notices on its next poll.
    store.cancelled.add("t-remote")
    assert await is_cancelled() is False  # still inside the interval
    clock["t"] += turn_runner_mod._CANCEL_POLL_INTERVAL_S + 0.01
    assert await is_cancelled() is True


class _Ev:
    def __init__(self, type_: str, data: dict) -> None:
        self.type = type_
        self.data = data


async def test_a_stop_inside_the_throttle_window_is_still_accounted() -> None:
    """The end-of-turn accounting read must NOT be throttled.

    `produce()` re-reads the cancel signal once the stream drains and uses it
    to decide refund + recorded state. Routing that read through the throttled
    streaming predicate made it answer "not cancelled" whenever the turn had
    just polled — so a cross-replica Stop was filed as a delivered answer:
    no refund, state="done". Caught by the existing turn-runner tests, which
    set the store flag directly; pinned explicitly here.
    """
    store = _CountingStore()
    runner = TurnRunner(store)
    seen: dict[str, bool] = {}

    async def stream(is_cancelled):
        yield _Ev("delta", {"text": "partial"})
        await is_cancelled()  # arms the throttle
        store.cancelled.add("t-window")  # another replica stops the turn now

    async def finalize(had_error: bool, completed: bool, answer_started: bool):
        seen["completed"] = completed
        seen["answer_started"] = answer_started
        return None

    queue = runner.start("t-window", "user-1", stream_factory=stream, finalize=finalize)
    while await queue.get() is not None:
        pass

    assert seen["completed"] is False
    assert seen["answer_started"] is True


async def test_a_local_stop_needs_no_remote_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The single-replica path: DELETE lands on this process, so the answer
    comes from the in-process event with no Redis call at all."""
    monkeypatch.setattr(turn_runner_mod, "monotonic", lambda: 100.0)
    store = _CountingStore()
    runner = TurnRunner(store)
    is_cancelled = await _capture_predicate(runner, trace_id="t-local")

    await is_cancelled()  # arms the throttle
    before = store.is_cancelled_calls
    runner._cancels["t-local"].set()

    assert await is_cancelled() is True
    assert store.is_cancelled_calls == before
