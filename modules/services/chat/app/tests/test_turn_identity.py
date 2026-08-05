"""One turn must carry ONE id.

`api/chat.py` resolves `effective_trace_id` (the client's `X-Trace-Id`, or a
server-minted fallback) and keys the turn buffer and cancel flag on it.
`run_chat_turn` used to re-derive its Langfuse trace id from the raw
`client_trace_id` with its own `or uuid4().hex`. When a client sent no
`X-Trace-Id` — legacy clients, and any non-browser caller — those two
`uuid4()` calls produced DIFFERENT ids for the same turn: the buffered result
was stored under one, the Langfuse trace recorded under the other, and nothing
could correlate them.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lectorium_chat.api import chat as chat_api
from lectorium_chat.api._auth import get_current_user
from lectorium_chat.application.rate_limiter import RateLimitResult
from lectorium_chat.composition import get_deps
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser


class _AllowingRateLimiter:
    async def check_and_increment(self, *args: Any, **kwargs: Any) -> RateLimitResult:
        return RateLimitResult(
            allowed=True, code=None, retry_after=0, current=1, limit=10, tier="free",
        )

    async def refund(self, *args: Any, **kwargs: Any) -> None:
        return None


class _NoopIdempotency:
    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        return True

    async def release(self, key: str) -> None:
        return None


class _CapturingRunner:
    """Stands in for TurnRunner: records the id the turn is keyed on, drives
    the route's stream factory once so the request DTO gets built, then ends
    the stream immediately."""

    def __init__(self) -> None:
        self.started_with: str | None = None

    def start(self, trace_id: str, user_id: str, *, stream_factory, finalize):
        self.started_with = trace_id

        async def _never_cancelled() -> bool:
            return False

        stream_factory(_never_cancelled)
        queue: asyncio.Queue = asyncio.Queue()
        queue.put_nowait(None)
        return queue


class _Deps:
    def __init__(self, runner: _CapturingRunner) -> None:
        self.rate_limiter = _AllowingRateLimiter()
        self.idempotency_store = _NoopIdempotency()
        self.turn_runner = runner


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")


def _post(deps: _Deps, headers: dict[str, str]) -> Any:
    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: _USER
    app.dependency_overrides[get_deps] = lambda: deps
    client = TestClient(app, raise_server_exceptions=False)
    return client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
        headers={"X-Chat-Protocol-Version": "1", **headers},
    )


def _capture_request(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    # A plain function, NOT an async generator: the route builds the request
    # as a call argument, so the capture has to happen when the call is made
    # rather than when the resulting stream is first iterated.
    def _fake_run_chat_turn(request, *, deps, is_disconnected=None):
        seen["request"] = request

        async def _empty():
            return
            yield  # pragma: no cover — makes this an async generator

        return _empty()

    monkeypatch.setattr(chat_api, "run_chat_turn", _fake_run_chat_turn)
    return seen


def test_turn_store_key_and_trace_id_match_without_x_trace_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _capture_request(monkeypatch)
    runner = _CapturingRunner()

    _post(_Deps(runner), headers={})

    assert runner.started_with, "runner was never started"
    assert seen["request"].trace_id == runner.started_with


def test_client_supplied_trace_id_is_used_verbatim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _capture_request(monkeypatch)
    runner = _CapturingRunner()
    trace = "b" * 32

    _post(_Deps(runner), headers={"X-Trace-Id": trace})

    assert runner.started_with == trace
    assert seen["request"].trace_id == trace


def test_malformed_trace_id_still_yields_one_shared_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected header falls back to a server id — the same one on both
    sides, which is exactly the case that used to diverge."""
    seen = _capture_request(monkeypatch)
    runner = _CapturingRunner()

    _post(_Deps(runner), headers={"X-Trace-Id": "not-a-trace-id"})

    assert runner.started_with
    assert seen["request"].trace_id == runner.started_with
