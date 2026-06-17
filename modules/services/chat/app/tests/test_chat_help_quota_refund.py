"""A "help" turn doesn't eat the user's daily chat quota.

The rate gate charges every turn BEFORE the router classifies intent, so
help can't be admitted for free. Instead, once the router emits its
decision (`status` / key=router_decision / params.intent=help) the route
refunds the charged unit in finalize() — net zero against the limit. A
non-exempt intent (research) keeps its charge.

Driven against the real POST /chat handler + runner with a fake LLM
stream and a refund-recording rate limiter (same harness shape as
test_chat_disconnect_resume).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

from fastapi import Request

from lectorium_chat.api import chat as chat_api
from lectorium_chat.api.chat import chat
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

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(self, trace_id: str, *, state: str, events: list, user_id: str) -> None:
        self.finished[trace_id] = {"state": state, "user_id": user_id, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.finished.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        return None

    async def is_cancelled(self, trace_id: str) -> bool:
        return False


class _RecordingRateLimiter:
    """Admits every turn at current=5/limit=10; records refund calls and
    reports the post-refund count (4) so the usage chip is checkable."""

    def __init__(self) -> None:
        self.refund_calls = 0

    async def check_and_increment(self, *args, **kwargs):
        return SimpleNamespace(allowed=True, current_after=5, limit_for_scope=10)

    async def refund(self, *args, **kwargs):
        self.refund_calls += 1
        return 4


class _FakeIdempotency:
    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        return True

    async def release(self, key: str) -> None:
        return None


class _Deps:
    def __init__(self, store: _FakeTurnStore, limiter: _RecordingRateLimiter) -> None:
        self.turn_store = store
        self.turn_runner = TurnRunner(store)
        self.rate_limiter = limiter
        self.idempotency_store = _FakeIdempotency()


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_TRACE = "b" * 32


def _make_request() -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/chat", "headers": [], "client": ("127.0.0.1", 0)}
    )


def _body() -> ChatRequestDto:
    return ChatRequestDto.model_validate(
        {"messages": [{"role": "user", "content": "what can you do?"}], "lang": "en"}
    )


async def _wait(predicate, tries: int = 100) -> None:
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0.02)


def _usage_current(events: list[dict[str, Any]]) -> int:
    frame = next(e for e in events if e["event"] == "usage")
    return json.loads(frame["data"])["current"]


def _stream_with_intent(intent: str):
    async def _fake_stream(*_args, **_kwargs):
        # Router decision arrives mid-stream exactly as the real graph emits it.
        yield _FakeAgentEvent(
            "status", {"key": "router_decision", "params": {"intent": intent}}
        )
        yield _FakeAgentEvent("delta", {"text": "answer"})
        yield _FakeAgentEvent("done", {})

    return _fake_stream


async def _run(monkeypatch, intent: str) -> tuple[_RecordingRateLimiter, dict[str, Any]]:
    monkeypatch.setattr(chat_api, "run_chat_turn", lambda *a, **k: _stream_with_intent(intent)())
    store = _FakeTurnStore()
    limiter = _RecordingRateLimiter()
    deps = _Deps(store, limiter)

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
    return limiter, store.finished[_TRACE]


async def test_help_turn_is_refunded(monkeypatch) -> None:
    limiter, finished = await _run(monkeypatch, "help")
    assert finished["state"] == "done"
    # The charged unit is credited back, and the buffered usage chip
    # reflects the post-refund count (4), not the charged 5.
    assert limiter.refund_calls == 1
    assert _usage_current(finished["events"]) == 4


async def test_research_turn_keeps_its_charge(monkeypatch) -> None:
    limiter, finished = await _run(monkeypatch, "research")
    assert finished["state"] == "done"
    # A normal answer turn consumes its unit — no refund, chip shows 5.
    assert limiter.refund_calls == 0
    assert _usage_current(finished["events"]) == 5
