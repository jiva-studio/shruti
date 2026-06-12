"""End-to-end: a client that drops the connection MID-STREAM doesn't lose the
answer.

Drives the real POST /chat handler with a fake LLM stream, then simulates a
client disconnect (nobody consumes the SSE response). Asserts the detached
producer keeps running, completes, and buffers the whole turn — and that
GET /chat/turn/{trace_id} ("coming back later") returns the complete answer.
This is the scenario the feature exists for, exercised against the real
route + runner + resume endpoint (no HTTP transport — sse-starlette over
httpx's ASGITransport buffers the whole stream and can't model an open SSE).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

from fastapi import Request

from lectorium_chat.api import chat as chat_api
from lectorium_chat.api.chat import chat, get_turn
from lectorium_chat.api.schemas.chat import ChatRequestDto
from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser


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
        self.finished[trace_id] = {"state": state, "user_id": user_id, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.finished.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        return trace_id in self.cancelled


class _AllowRateLimiter:
    async def check_and_increment(self, *args, **kwargs):
        return SimpleNamespace(allowed=True, current_after=1, limit_for_scope=10)

    async def refund(self, *args, **kwargs):
        return None


class _FakeIdempotency:
    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        return True

    async def release(self, key: str) -> None:
        return None


class _Deps:
    def __init__(self, store: _FakeTurnStore) -> None:
        self.turn_store = store
        self.turn_runner = TurnRunner(store)
        self.rate_limiter = _AllowRateLimiter()
        self.idempotency_store = _FakeIdempotency()


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_TRACE = "b" * 32


def _make_request() -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/chat", "headers": [], "client": ("127.0.0.1", 0)}
    )


def _body() -> ChatRequestDto:
    return ChatRequestDto.model_validate(
        {"messages": [{"role": "user", "content": "hi"}], "lang": "en"}
    )


async def _wait(predicate, tries: int = 100) -> None:
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0.02)


async def test_disconnect_midstream_completes_and_resumes(monkeypatch) -> None:
    # Fake LLM stream: two deltas, then PARK — so the turn is provably still
    # generating when the client "disconnects" (never consumes the response).
    release_done = asyncio.Event()

    async def _fake_stream(*_args, **_kwargs):
        yield _FakeAgentEvent("delta", {"text": "part 1 "})
        yield _FakeAgentEvent("delta", {"text": "part 2"})
        await release_done.wait()
        yield _FakeAgentEvent("done", {})

    monkeypatch.setattr(chat_api, "run_chat_turn", lambda *a, **k: _fake_stream())

    store = _FakeTurnStore()
    deps = _Deps(store)

    # POST /chat — returns the SSE response and spawns the detached producer.
    # We never consume the response body == an immediate client disconnect.
    resp = await chat(
        _make_request(),
        _body(),
        x_chat_protocol_version="1",
        idempotency_key=None,
        x_trace_id=_TRACE,
        user=_USER,
        deps=deps,
    )
    assert resp.status_code == 200

    # The turn is still generating (parked) despite no consumer — nothing
    # buffered yet.
    await asyncio.sleep(0.05)
    assert _TRACE not in store.finished, "turn should still run after disconnect"

    # Let it finish; the detached producer keeps going and buffers everything.
    release_done.set()
    await _wait(lambda: _TRACE in store.finished)
    assert store.finished[_TRACE]["state"] == "done"

    # "Come back later" — poll the turn and get the complete answer.
    body = await get_turn(_TRACE, user=_USER, deps=deps)
    assert body["state"] == "done"
    kinds = [e["event"] for e in body["events"]]
    assert kinds[:2] == ["delta", "delta"]
    assert "done" in kinds
    assert "usage" in kinds  # usage frame is buffered for resume too
    prose = "".join(
        json.loads(e["data"])["text"] for e in body["events"] if e["event"] == "delta"
    )
    assert prose == "part 1 part 2"


async def test_explicit_cancel_stops_the_turn(monkeypatch) -> None:
    # An explicit Stop (DELETE → turn_runner.cancel) actually cancels: the
    # stream checks the predicate and returns early, before `done`.
    async def _fake_stream(*_args, is_disconnected=None, **_kwargs):
        yield _FakeAgentEvent("delta", {"text": "partial"})
        if is_disconnected is not None and await is_disconnected():
            return
        yield _FakeAgentEvent("done", {})

    monkeypatch.setattr(chat_api, "run_chat_turn", lambda *a, **k: _fake_stream(*a, **k))

    store = _FakeTurnStore()
    deps = _Deps(store)
    await deps.turn_runner.cancel(_TRACE)  # Stop requested up-front

    resp = await chat(
        _make_request(),
        _body(),
        x_chat_protocol_version="1",
        idempotency_key=None,
        x_trace_id=_TRACE,
        user=_USER,
        deps=deps,
    )
    assert resp.status_code == 200

    await _wait(lambda: _TRACE in store.finished)
    kinds = [e["event"] for e in store.finished[_TRACE]["events"]]
    assert "done" not in kinds  # cancelled before completion
