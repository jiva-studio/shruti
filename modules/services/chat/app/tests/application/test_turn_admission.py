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

from lectorium_chat.application.turn_runner import (
    TurnAlreadyRunning,
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


# ── duplicate trace ids ─────────────────────────────────────────────────


def _counting_factory(release: asyncio.Event, started: list[int]):
    """A held producer that records that it actually began running."""

    def factory(is_cancelled):
        async def _held():
            started.append(len(started))
            await release.wait()
            return
            yield  # pragma: no cover — makes this an async generator

        return _held()

    return factory


async def test_a_repeated_trace_id_does_not_stack_producers() -> None:
    """The registry is keyed by trace id and `X-Trace-Id` is client-supplied:
    without a dedup guard the second `start()` OVERWRITES the first's entry,
    so N producers run while `in_flight()` stays at 1 and the ceiling below
    never fires."""
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=2)
    release = asyncio.Event()
    started: list[int] = []
    factory = _counting_factory(release, started)

    runner.start("dup", "u", stream_factory=factory, finalize=_noop_finalize)
    for _ in range(4):
        with pytest.raises(TurnAlreadyRunning):
            runner.start("dup", "u", stream_factory=factory, finalize=_noop_finalize)

    await asyncio.sleep(0)
    assert runner.in_flight() == 1
    assert started == [0]

    release.set()
    await runner.shutdown()
    assert runner.in_flight() == 0


async def test_repeated_ids_cannot_bypass_the_ceiling() -> None:
    """The whole point of the guard: one client hammering a single trace id
    can occupy exactly one admission slot, and distinct ids still hit the
    ceiling — with the plain capacity error, not the duplicate one."""
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=2)
    release = asyncio.Event()
    started: list[int] = []
    factory = _counting_factory(release, started)

    for _ in range(5):
        try:
            runner.start("dup", "u", stream_factory=factory, finalize=_noop_finalize)
        except TurnAlreadyRunning:
            pass
    runner.start("other", "u", stream_factory=factory, finalize=_noop_finalize)
    await asyncio.sleep(0)
    assert runner.in_flight() == 2
    assert started == [0, 1]

    with pytest.raises(TurnCapacityExceeded) as excinfo:
        runner.start("third", "u", stream_factory=factory, finalize=_noop_finalize)
    assert not isinstance(excinfo.value, TurnAlreadyRunning)

    release.set()
    await runner.shutdown()


async def test_a_finished_turn_frees_its_trace_id() -> None:
    """Dedup is on the LIVE registry, not a history: once the turn ends the
    same id is admissible again (a client resuming after a completed turn)."""
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=2)

    def factory(is_cancelled):
        async def _quick():
            yield _Ev("delta", {"text": "hi"})

        return _quick()

    await _drain(
        runner.start("same", "u", stream_factory=factory, finalize=_noop_finalize)
    )
    assert runner.in_flight() == 0
    await _drain(
        runner.start("same", "u", stream_factory=factory, finalize=_noop_finalize)
    )
    assert runner.in_flight() == 0


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
    assert json.loads(frames[-1]["data"])["code"] == "turn_timeout"
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
        from lectorium_chat.application.rate_limiter import RateLimitResult

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


class _DuplicateRunner:
    def start(self, *a: Any, **kw: Any):
        raise TurnAlreadyRunning("dup")


class _Deps:
    def __init__(self, runner: Any | None = None) -> None:
        self.rate_limiter = _AllowingRateLimiter()
        self.idempotency_store = _TrackingIdempotency()
        self.turn_runner = runner or _FullRunner()


def test_route_rejects_with_503_and_undoes_the_charge() -> None:
    """`finalize` never runs on this path, so the route itself has to undo
    what the gates already did — otherwise a user told "try again" loses a
    quota unit and then bounces off their own idempotency key for its TTL."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from lectorium_chat.api import chat as chat_api
    from lectorium_chat.api._auth import get_current_user
    from lectorium_chat.composition import get_deps
    from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser

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


def test_route_rejects_a_duplicate_trace_id_with_409() -> None:
    """A reused trace id is the client's conflict, not server load: retrying
    the same request unchanged bounces for as long as the first turn runs, so
    it must not be advertised as retryable (no 503 / `Retry-After`). The
    charge and the key are still undone — this request never ran."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from lectorium_chat.api import chat as chat_api
    from lectorium_chat.api._auth import get_current_user
    from lectorium_chat.composition import get_deps
    from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser

    user = VerifiedUser(id="user-1", anonymous=False, tier="free")
    deps = _Deps(_DuplicateRunner())
    key = "idem-key-0002"

    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_deps] = lambda: deps
    client = TestClient(app, raise_server_exceptions=False)

    r = client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
        headers={
            "X-Chat-Protocol-Version": "1",
            "Idempotency-Key": key,
            "X-Trace-Id": "a" * 32,
        },
    )

    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "turn_already_running"
    assert "Retry-After" not in r.headers
    assert deps.rate_limiter.refunds == 1
    assert f"chat:{user.id}:{key}" not in deps.idempotency_store.held


async def test_route_rejects_a_duplicate_trace_id_through_the_real_runner() -> None:
    """The test above pins the route's mapping with a double that raises
    `TurnAlreadyRunning` on command, so it survives the guard being deleted
    from `TurnRunner.start`. This one wires the REAL runner in: a turn is
    already in flight on the id, and the route has to bounce the second
    request rather than spawn a producer that silently overwrites the first.
    """
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from lectorium_chat.api import chat as chat_api
    from lectorium_chat.api._auth import get_current_user
    from lectorium_chat.composition import get_deps
    from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser

    user = VerifiedUser(id="user-1", anonymous=False, tier="free")
    key = "idem-key-0003"
    trace_id = "b" * 32

    runner = TurnRunner(_FakeTurnStore(), max_in_flight=4)
    release = asyncio.Event()
    started: list[int] = []
    runner.start(
        trace_id, user.id,
        stream_factory=_counting_factory(release, started),
        finalize=_noop_finalize,
    )
    await asyncio.sleep(0)

    deps = _Deps(runner)
    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_deps] = lambda: deps

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver",
        ) as client:
            r = await client.post(
                "/chat",
                json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
                headers={
                    "X-Chat-Protocol-Version": "1",
                    "Idempotency-Key": key,
                    "X-Trace-Id": trace_id,
                },
            )

        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "turn_already_running"
        assert "Retry-After" not in r.headers
        assert started == [0], "the route must not have spawned a second producer"
        assert runner.in_flight() == 1
        assert deps.rate_limiter.refunds == 1
        assert f"chat:{user.id}:{key}" not in deps.idempotency_store.held
    finally:
        release.set()
        await runner.shutdown()
