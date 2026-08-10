"""Turns must be bounded in count and in wall-clock time.

The daily quotas bound VOLUME, not CONCURRENCY, and a turn runs detached — a
client that backgrounds the app does not cancel it. So nothing stopped
producers piling up, and an abandoned one could run to the ReAct ceiling times
the 180s LLM timeout (~21 minutes of billed generation) before ending.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from shruti_chat.agent.events import ERROR_MESSAGES
from shruti_chat.application.turn_runner import (
    TurnCapacityExceeded,
    TurnRunner,
)


class _FakeTurnStore:
    def __init__(self) -> None:
        self.finished: dict[str, dict[str, Any]] = {}
        self.cancelled: set[str] = set()

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(
        self, trace_id: str, *, state: str, events: list[Any], user_id: str
    ) -> None:
        self.finished[trace_id] = {"state": state, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.finished.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        return trace_id in self.cancelled


class _Ev:
    def __init__(self, type_: str, data: dict) -> None:
        self.type = type_
        self.data = data


async def _noop_finalize(had_error: bool, completed: bool, answer_started: bool):
    return None


async def _drain(queue: asyncio.Queue) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    while True:
        frame = await queue.get()
        if frame is None:
            return frames
        frames.append(frame)


# ── in-flight ceiling ───────────────────────────────────────────────────


async def test_start_rejects_past_the_ceiling() -> None:
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=2)
    release = asyncio.Event()

    def factory(is_cancelled):
        async def _held():
            await release.wait()
            return
            yield  # pragma: no cover — makes this an async generator

        return _held()

    for i in range(2):
        runner.start(f"t{i}", "u", stream_factory=factory, finalize=_noop_finalize)
    await asyncio.sleep(0)
    assert runner.in_flight() == 2

    with pytest.raises(TurnCapacityExceeded):
        runner.start("t-over", "u", stream_factory=factory, finalize=_noop_finalize)

    release.set()


async def test_a_finished_turn_frees_a_slot() -> None:
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=1)

    def factory(is_cancelled):
        async def _empty():
            return
            yield  # pragma: no cover

        return _empty()

    q = runner.start("t0", "u", stream_factory=factory, finalize=_noop_finalize)
    await _drain(q)
    assert runner.in_flight() == 0

    # The slot is reusable — the cap is on concurrency, not on lifetime volume.
    q = runner.start("t1", "u", stream_factory=factory, finalize=_noop_finalize)
    await _drain(q)


async def test_zero_disables_the_ceiling() -> None:
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=0)
    release = asyncio.Event()

    def factory(is_cancelled):
        async def _held():
            await release.wait()
            return
            yield  # pragma: no cover

        return _held()

    for i in range(5):
        runner.start(f"t{i}", "u", stream_factory=factory, finalize=_noop_finalize)
    await asyncio.sleep(0)
    assert runner.in_flight() == 5

    release.set()


# ── wall-clock budget ───────────────────────────────────────────────────


async def test_a_turn_over_budget_ends_as_an_error() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store, turn_budget_s=0.02)
    seen: dict[str, bool] = {}

    def factory(is_cancelled):
        async def _slow():
            yield _Ev("status", {"key": "thinking"})
            await asyncio.sleep(5)
            yield _Ev("done", {})  # pragma: no cover — never reached

        return _slow()

    async def finalize(had_error: bool, completed: bool, answer_started: bool):
        seen["had_error"] = had_error
        seen["completed"] = completed
        return None

    frames = await _drain(
        runner.start("t-slow", "u", stream_factory=factory, finalize=finalize)
    )

    # The client's last frame explains what happened rather than the stream
    # simply stopping.
    assert frames[-1]["event"] == "error"
    payload = json.loads(frames[-1]["data"])
    assert payload["code"] == "turn_timeout"
    # Built by the one choke point, so a client with no string for the code
    # still has something to render (issue #1568).
    assert payload["message"] == ERROR_MESSAGES["turn_timeout"]
    # And the accounting treats it as a failure: finalize refunds, the store
    # records `error`, not a truncated `done`.
    assert seen["had_error"] is True
    assert seen["completed"] is False
    assert store.finished["t-slow"]["state"] == "error"


async def test_a_turn_inside_the_budget_is_untouched() -> None:
    store = _FakeTurnStore()
    runner = TurnRunner(store, turn_budget_s=5.0)

    def factory(is_cancelled):
        async def _quick():
            yield _Ev("delta", {"text": "hi"})
            yield _Ev("done", {})

        return _quick()

    frames = await _drain(
        runner.start("t-ok", "u", stream_factory=factory, finalize=_noop_finalize)
    )

    assert [f["event"] for f in frames] == ["delta", "done"]
    assert store.finished["t-ok"]["state"] == "done"


# ── route behaviour on rejection ────────────────────────────────────────


class _AllowingRateLimiter:
    def __init__(self) -> None:
        self.refunds = 0

    async def check_and_increment(self, *args: Any, **kwargs: Any):
        from shruti_chat.application.rate_limiter import RateLimitResult

        return RateLimitResult(
            allowed=True, code=None, retry_after=0, current=1, limit=10, tier="free",
        )

    async def refund(self, *args: Any, **kwargs: Any) -> int | None:
        self.refunds += 1
        return 0


class _TrackingIdempotency:
    def __init__(self) -> None:
        self.held: set[str] = set()

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        self.held.add(key)
        return True

    async def release(self, key: str) -> None:
        self.held.discard(key)


class _FullRunner:
    def start(self, *a: Any, **kw: Any):
        raise TurnCapacityExceeded("full")


class _Deps:
    def __init__(self) -> None:
        self.rate_limiter = _AllowingRateLimiter()
        self.idempotency_store = _TrackingIdempotency()
        self.turn_runner = _FullRunner()


def test_route_rejects_with_503_and_undoes_the_charge() -> None:
    """`finalize` never runs on this path, so the route itself has to undo
    what the gates already did — otherwise a user told "try again" loses a
    quota unit and then bounces off their own idempotency key for its TTL."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from shruti_chat.api import chat as chat_api
    from shruti_chat.api._auth import get_current_user
    from shruti_chat.composition import get_deps
    from shruti_chat.infra.auth.jwt_verifier import VerifiedUser

    user = VerifiedUser(id="user-1", anonymous=False, tier="free")
    deps = _Deps()
    key = "idem-key-0001"

    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_deps] = lambda: deps
    client = TestClient(app, raise_server_exceptions=False)

    r = client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
        headers={"X-Chat-Protocol-Version": "1", "Idempotency-Key": key},
    )

    assert r.status_code == 503
    assert r.headers.get("Retry-After") == "5"
    assert deps.rate_limiter.refunds == 1
    assert f"chat:{user.id}:{key}" not in deps.idempotency_store.held
