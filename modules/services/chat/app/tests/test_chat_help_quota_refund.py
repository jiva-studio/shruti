"""A "help" turn doesn't eat the user's daily chat quota.

The rate gate charges every turn BEFORE the router classifies intent, so
help can't be admitted for free. Instead, once the router emits its
decision (`status` / key=router_decision / params.intent=help) the route
refunds the charged unit in finalize() — net zero against the limit. A
non-exempt intent (research) keeps its charge.

Driven against the real POST /chat handler + runner with a fake LLM
stream and a refund-recording rate limiter (same harness shape as
test_chat_disconnect_resume). The mid-stream router_decision event is
NOT fabricated — it's captured from a real `router_node` run so the
producer/consumer contract is genuinely exercised.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import Request

from lectorium_chat.agent.graph.nodes import router as router_node_mod
from lectorium_chat.agent.graph.nodes.router import router_node
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.api import chat as chat_api
from lectorium_chat.api.chat import chat
from lectorium_chat.api.schemas.chat import ChatRequestDto
from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.domain.routing import RoutingDecision
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


@dataclass
class _RouterCtx:
    llm: Any | None = None
    request_id: str = "req-test"
    kv_cache: Any | None = None
    embed_task: Any | None = None
    langfuse_trace_id: str | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    lang: str = "ru"
    lang_name: str = ""
    author_scope: Any | None = None


@dataclass
class _RouterRuntime:
    context: _RouterCtx


async def _real_router_decision_event(
    monkeypatch: pytest.MonkeyPatch, intent: str
) -> dict[str, Any]:
    """Run the REAL `router_node` and return the status event it emits.

    The whole point of this test is the producer/consumer contract between
    `router_node` (emits the SSE status event) and the API refund path
    (consumes it). Fabricating the event would let the producer regress
    silently — so we drive the node for real (with a scripted decision +
    no-op classifier chain) and capture exactly what it pushes."""
    emitted: list[dict[str, Any]] = []

    async def _no_classifier(*_a, **_k):
        return None

    async def _identity_rewrite(_history, query, **_k):
        return query

    async def _fake_router_turn(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(intent=intent, confidence=0.95, extracted_args={})

    monkeypatch.setattr(router_node_mod, "get_stream_writer", lambda: emitted.append)
    monkeypatch.setattr(router_node_mod, "run_classifier_chain", _no_classifier)
    monkeypatch.setattr(router_node_mod, "resolve_followup_query", _identity_rewrite)
    monkeypatch.setattr(router_node_mod, "run_router_turn", _fake_router_turn)

    await router_node(
        {"user_query": "what can you do?", "lang": "en", "history": []},
        _RouterRuntime(_RouterCtx()),
    )

    decision_events = [
        e
        for e in emitted
        if e.get("type") == "status"
        and (e.get("data") or {}).get("key") == "router_decision"
    ]
    assert len(decision_events) == 1, "router_node must emit exactly one decision event"
    return decision_events[0]


def _stream_with_intent(intent: str, router_event: dict[str, Any]):
    async def _fake_stream(*_args, **_kwargs):
        # Router decision arrives mid-stream — and `router_event` is the
        # payload the REAL `router_node` produced (captured in `_run`), so
        # this exercises the genuine producer/consumer contract rather than
        # a hand-fabricated shape.
        yield _FakeAgentEvent(router_event["type"], router_event["data"])
        yield _FakeAgentEvent("delta", {"text": "answer"})
        yield _FakeAgentEvent("done", {})

    return _fake_stream


async def _run(monkeypatch, intent: str) -> tuple[_RecordingRateLimiter, dict[str, Any]]:
    router_event = await _real_router_decision_event(monkeypatch, intent)
    monkeypatch.setattr(
        chat_api, "run_chat_turn", lambda *a, **k: _stream_with_intent(intent, router_event)()
    )
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
