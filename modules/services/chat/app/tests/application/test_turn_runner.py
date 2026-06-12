"""TurnRunner — the detached-producer lifecycle, now testable in isolation.

Before the M2 refactor this logic lived in the API route as module-level
globals and could only be exercised end-to-end through the HTTP handler.
As an injectable application service it has its own unit tests.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from lectorium_chat.application.turn_runner import TurnRunner


class _FakeAgentEvent:
    def __init__(self, type_: str, data: dict[str, Any]) -> None:
        self.type = type_
        self.data = data


class _FakeTurnStore:
    def __init__(self) -> None:
        self.finished: dict[str, dict[str, Any]] = {}
        self.running: set[str] = set()
        self.cancelled: set[str] = set()

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        self.running.add(trace_id)

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(self, trace_id: str, *, state: str, events: list, user_id: str) -> None:
        self.finished[trace_id] = {"state": state, "events": events, "user_id": user_id}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.finished.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        return trace_id in self.cancelled


async def _drain(queue) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    while True:
        frame = await queue.get()
        if frame is None:
            break
        frames.append(frame)
    return frames


async def test_buffers_events_and_finishes_done() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store)

    async def stream(_is_cancelled):
        yield _FakeAgentEvent("delta", {"text": "hi"})
        yield _FakeAgentEvent("done", {})

    async def finalize(had_error: bool, completed: bool):
        assert had_error is False and completed is True
        return {"event": "usage", "data": json.dumps({"scope": "chat"})}

    queue = runner.start("t1", "user-1", stream_factory=stream, finalize=finalize)
    frames = await _drain(queue)

    # delta + done reached the live consumer, then the finalize usage frame.
    assert [f["event"] for f in frames] == ["delta", "done", "usage"]
    # The full ordered list is persisted for resume, state done.
    record = store.finished["t1"]
    assert record["state"] == "done"
    assert [f["event"] for f in record["events"]] == ["delta", "done", "usage"]


async def test_error_event_marks_turn_error() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store)

    async def stream(_is_cancelled):
        yield _FakeAgentEvent("error", {"code": "boom"})

    async def finalize(had_error: bool, completed: bool):
        assert had_error is True
        return None

    queue = runner.start("t2", "user-1", stream_factory=stream, finalize=finalize)
    await _drain(queue)

    assert store.finished["t2"]["state"] == "error"


async def test_cancel_sets_cross_replica_flag() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store)

    await runner.cancel("t3")

    assert "t3" in store.cancelled


async def test_finalize_raising_still_finishes_and_sentinels() -> None:
    # A raise in finalize() must NOT skip the sentinel / finish — otherwise an
    # attached SSE consumer would hang on the queue forever.
    store = _FakeTurnStore()
    runner = TurnRunner(store)

    async def stream(_is_cancelled):
        yield _FakeAgentEvent("delta", {"text": "hi"})

    async def finalize(had_error: bool, completed: bool):
        raise RuntimeError("boom in finalize")

    queue = runner.start("t4", "user-1", stream_factory=stream, finalize=finalize)
    frames = await _drain(queue)  # terminates only because the sentinel was queued

    assert [f["event"] for f in frames] == ["delta"]  # no usage frame — finalize failed
    assert store.finished["t4"]["state"] == "done"  # turn still buffered for resume


async def test_shutdown_cancels_inflight_without_hanging() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store)
    ready = asyncio.Event()

    async def stream(_is_cancelled):
        ready.set()
        yield _FakeAgentEvent("delta", {"text": "hi"})
        await asyncio.sleep(3600)  # hang until cancelled

    async def finalize(had_error: bool, completed: bool):
        return None

    runner.start("t5", "user-1", stream_factory=stream, finalize=finalize)
    await ready.wait()
    # Must cancel the in-flight producer and return promptly.
    await asyncio.wait_for(runner.shutdown(), timeout=2.0)
