"""Tests for `agent/graph/nodes/router.py` — the graph node that bridges
state ↔ `run_router_turn` and surfaces the routing decision on the stream.

Two contracts are exercised here that pure-use-case tests can't reach:

1. The node emits a `status` / key=router_decision / params.intent event
   via the LangGraph stream writer. The API layer's help-quota refund and
   the Langfuse `router_intent` score both depend on this event existing —
   without it the refund path is dead code.
2. A genuine router parse failure (run_router_turn raises after retries +
   fallback + salvage are exhausted) must NOT kill the turn. The node
   degrades to intent="unknown" — the documented soft-fallback path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes import router as router_node_mod
from shruti_chat.agent.graph.nodes.router import router_node
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.routing import RoutingDecision


@dataclass
class _Ctx:
    llm: Any | None = None
    request_id: str = "req-test"
    kv_cache: Any | None = None
    embed_task: Any | None = None
    langfuse_trace_id: str | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    lang: str = "ru"


@dataclass
class _Runtime:
    context: _Ctx


def _state(query: str = "что ты умеешь") -> dict[str, Any]:
    return {"user_query": query, "lang": "ru", "history": []}


@pytest.fixture
def _capture_stream(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture every payload pushed through the node's stream writer.

    `get_stream_writer()` only works inside a running graph; outside one
    we substitute a recorder so the emitted status events are assertable.
    """
    emitted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        router_node_mod, "get_stream_writer", lambda: emitted.append
    )
    return emitted


@pytest.fixture(autouse=True)
def _force_llm_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the deterministic chain + follow-up rewrite no-ops so the node
    always reaches the LLM-router fall-through (where the decision is
    produced). Keeps these node tests independent of classifier internals."""

    async def _no_classifier(*_a, **_k):
        return None

    async def _identity_rewrite(_history, query, **_k):
        return query

    monkeypatch.setattr(router_node_mod, "run_classifier_chain", _no_classifier)
    monkeypatch.setattr(
        router_node_mod, "resolve_followup_query", _identity_rewrite
    )


def _router_decision_events(emitted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        e
        for e in emitted
        if e.get("type") == "status"
        and (e.get("data") or {}).get("key") == "router_decision"
    ]


async def test_router_node_emits_router_decision_event(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """The node pushes a status/router_decision event carrying the chosen
    intent — the exact event the API refund path + Langfuse score read."""

    async def _fake_router_turn(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(intent="help", confidence=0.95, extracted_args={})

    monkeypatch.setattr(router_node_mod, "run_router_turn", _fake_router_turn)

    out = await router_node(_state(), _Runtime(_Ctx()))

    assert out["intent"] == "help"
    events = _router_decision_events(_capture_stream)
    assert len(events) == 1
    assert events[0]["data"]["params"]["intent"] == "help"


async def test_router_node_event_carries_actual_intent(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """A non-exempt intent (research) is surfaced verbatim — proves the
    event mirrors the real decision, not a hard-coded value."""

    async def _fake_router_turn(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(intent="research", confidence=0.9, extracted_args={})

    monkeypatch.setattr(router_node_mod, "run_router_turn", _fake_router_turn)

    out = await router_node(_state(), _Runtime(_Ctx()))

    assert out["intent"] == "research"
    events = _router_decision_events(_capture_stream)
    assert events[0]["data"]["params"]["intent"] == "research"


async def test_router_parse_failure_soft_falls_to_unknown(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """A parse failure that exhausted retries + fallback + salvage raises
    out of run_router_turn. The node must catch it and degrade to
    intent="unknown" so the turn proceeds, NOT re-raise and kill the turn."""

    async def _boom(*_a, **_k) -> RoutingDecision:
        raise RuntimeError("structured-output parse failed after fallback")

    monkeypatch.setattr(router_node_mod, "run_router_turn", _boom)

    # Must not raise — the whole point of the fix.
    out = await router_node(_state(), _Runtime(_Ctx()))

    assert out["intent"] == "unknown"
    assert out["confidence"] == 0.0
    assert out["extracted_args"] == {}
    # The decision event still fires on the soft-fallback path so the API
    # layer observes intent=unknown rather than seeing nothing.
    events = _router_decision_events(_capture_stream)
    assert events[0]["data"]["params"]["intent"] == "unknown"
