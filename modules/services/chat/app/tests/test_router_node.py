"""Tests for `agent/graph/nodes/router.py` — the graph node that bridges
state ↔ `run_router_turn` and surfaces the routing decision on the stream.

Contracts exercised here that pure-use-case tests can't reach:

1. The node emits a `status` / key=router_decision / params.intent event
   via the LangGraph stream writer. The API layer's help-quota refund and
   the Langfuse `router_intent` score both depend on this event existing —
   without it the refund path is dead code.
2. A genuine router parse failure (run_router_turn raises after retries +
   fallback + salvage are exhausted) must NOT kill the turn. The node
   degrades to intent="unknown" — the documented soft-fallback path.
3. Conversation attributes are settled here. The reply language — today's
   only attribute — is published to BOTH `state["lang"]` and `ctx.lang`. Downstream hops read one or the other — the synthesizer the
   state, `localized_reply` and the card blurbs `ctx.lang` — and when they
   derived the language separately they disagreed (a Hindi answer under an
   English summary, on production). It also has to overlap the router's own
   LLM call, or it costs a second round-trip on every turn.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import router as router_node_mod
from lectorium_chat.agent.graph.nodes.router import router_node
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.conversation_attributes import (
    REPLY_LANGUAGE,
    Attribute,
)
from lectorium_chat.domain.routing import RoutingDecision


@dataclass
class _Ctx:
    llm: Any | None = None
    request_id: str = "req-test"
    kv_cache: Any | None = None
    embed_task: Any | None = None
    langfuse_trace_id: str | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    lang: str = "ru"
    lang_name: str = ""
    catalog_repo: Any | None = None
    author_scope: Any | None = None


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


async def test_router_node_surfaces_add_to_library_intent(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """The new add-to-library intent flows through the node unchanged and is
    surfaced on the router_decision event (so downstream routing sees it)."""

    async def _fake_router_turn(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(
            intent="add-to-library", confidence=0.9, extracted_args={}
        )

    monkeypatch.setattr(router_node_mod, "run_router_turn", _fake_router_turn)

    out = await router_node(_state("add this video to my library"), _Runtime(_Ctx()))

    assert out["intent"] == "add-to-library"
    events = _router_decision_events(_capture_stream)
    assert events[0]["data"]["params"]["intent"] == "add-to-library"


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


# ── conversation attributes ───────────────────────────────────────────────


_RU_ASKED = {REPLY_LANGUAGE: Attribute(value="ru", label="Русский", explicit=True)}


@pytest.fixture
def _quiet_router(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_router_turn(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(intent="research", confidence=0.9, extracted_args={})

    monkeypatch.setattr(router_node_mod, "run_router_turn", _fake_router_turn)


def _detect(result: dict[str, Attribute] | None, *, calls: list[str]):
    async def _fake(query: str, **_k) -> dict[str, Attribute]:
        calls.append(query)
        return dict(result or {})

    return _fake


def _attribute_events(emitted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in emitted if e.get("type") == "attributes"]


async def test_a_detected_language_reaches_both_state_and_context(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """One resolved value, published to both readers — that's the fix. The
    event carries it out so the client can persist it on the message."""
    calls: list[str] = []
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(_RU_ASKED, calls=calls)
    )
    ctx = _Ctx(llm=object(), lang="en")
    state = {"user_query": "отвечай по-русски", "lang": "en", "history": []}

    out = await router_node(state, _Runtime(ctx))

    assert out["lang"] == "ru"
    assert ctx.lang == "ru"
    assert ctx.lang_name == "Русский"
    assert _attribute_events(_capture_stream)[0]["data"] == {
        REPLY_LANGUAGE: {"value": "ru", "label": "Русский", "explicit": True},
    }


async def test_detection_reads_the_typed_message_not_the_rewrite(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """The follow-up rewrite is written by another model, so its language says
    nothing about the person. Detection must see what they typed."""
    calls: list[str] = []
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(_RU_ASKED, calls=calls)
    )

    async def _rewrite_to_english(_history, _query, **_k) -> str:
        return "More verses on the nature of asuras"

    monkeypatch.setattr(
        router_node_mod, "resolve_followup_query", _rewrite_to_english
    )

    out = await router_node(
        {"user_query": "а ещё?", "lang": "en", "history": [{"role": "user", "content": "x"}]},
        _Runtime(_Ctx(llm=object())),
    )

    assert calls == ["а ещё?"]
    # The rewrite still lands in state — only the language input differs.
    assert out["user_query"] == "More verses on the nature of asuras"


async def test_nothing_settled_leaves_the_request_locale_in_force(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """Detector abstained and nothing was remembered: don't touch the language,
    and don't emit — storing a value we never derived would shadow a later
    change of the app's language."""
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(None, calls=[])
    )
    ctx = _Ctx(llm=object(), lang="en")

    out = await router_node({"user_query": "БГ 2.13", "lang": "en", "history": []}, _Runtime(ctx))

    assert "lang" not in out
    assert ctx.lang == "en"
    assert _attribute_events(_capture_stream) == []


async def test_a_remembered_request_carries_an_inconclusive_message(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """«отвечай по-русски» two turns ago, «7.1» now: the reply stays Russian,
    and the value is re-emitted so it rides forward instead of ageing out of
    the 20-message window the client replays."""
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(None, calls=[])
    )
    ctx = _Ctx(llm=object(), lang="en")
    history = [
        {"role": "user", "content": "отвечай по-русски"},
        {"role": "assistant", "content": "Хорошо.",
         "attributes": {REPLY_LANGUAGE: {"value": "ru", "label": "Русский",
                                        "explicit": True}}},
        {"role": "user", "content": "7.1"},
    ]

    out = await router_node(
        {"user_query": "7.1", "lang": "en", "history": history}, _Runtime(ctx)
    )

    assert out["lang"] == "ru"
    assert ctx.lang == "ru"
    assert _attribute_events(_capture_stream)[0]["data"][REPLY_LANGUAGE]["value"] == "ru"


async def test_a_claimed_query_costs_no_language_call(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """A bare address / lecture URL is claimed by the deterministic chain. There
    is no language to read in «БГ 2.13», so we don't pay for the call."""
    calls: list[str] = []
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(_RU_ASKED, calls=calls)
    )

    async def _claims(*_a, **_k) -> RoutingDecision:
        return RoutingDecision(intent="show_verse", confidence=1.0, extracted_args={})

    monkeypatch.setattr(router_node_mod, "run_classifier_chain", _claims)

    out = await router_node(_state("БГ 2.13"), _Runtime(_Ctx(llm=object())))

    assert out["intent"] == "show_verse"
    assert calls == []


async def test_detection_overlaps_the_router_call(
    monkeypatch: pytest.MonkeyPatch, _capture_stream: list[dict[str, Any]]
) -> None:
    """Concurrency, asserted rather than assumed: the two calls are in flight at
    the same time. Detection must have started before the router's call, and
    must still be unfinished while it runs — so either sequential order
    deadlocks instead of quietly costing a second round-trip per turn."""
    running = asyncio.Event()
    release = asyncio.Event()

    async def _slow_detect(_query: str, **_k) -> dict[str, Attribute]:
        running.set()
        await asyncio.wait_for(release.wait(), timeout=1)
        return _RU_ASKED

    async def _router_waits_for_detection(*_a, **_k) -> RoutingDecision:
        await asyncio.wait_for(running.wait(), timeout=1)
        release.set()
        return RoutingDecision(intent="research", confidence=0.9, extracted_args={})

    monkeypatch.setattr(router_node_mod, "detect_attributes", _slow_detect)
    monkeypatch.setattr(
        router_node_mod, "run_router_turn", _router_waits_for_detection
    )

    out = await router_node(_state("что такое карма?"), _Runtime(_Ctx(llm=object())))

    assert out["lang"] == "ru"


async def test_the_clients_aggregate_reaches_the_merge(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """The aggregate is the whole point of the metadata channel: it carries a
    language settled long before the 20 messages the request can hold."""
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(None, calls=[])
    )
    ctx = _Ctx(llm=object(), lang="en")

    out = await router_node(
        {
            "user_query": "7.1", "lang": "en", "history": [],
            "client_attributes": {
                REPLY_LANGUAGE: {"value": "ru", "label": "Русский", "explicit": True},
            },
        },
        _Runtime(ctx),
    )

    assert out["lang"] == "ru"
    assert ctx.lang == "ru" and ctx.lang_name == "Русский"


async def test_an_unknown_attribute_rides_through_untouched(
    monkeypatch: pytest.MonkeyPatch,
    _capture_stream: list[dict[str, Any]],
    _quiet_router: None,
) -> None:
    """The point of the map: a key this build knows nothing about is carried
    forward rather than dropped, so an older server cannot erase what a newer
    one settled."""
    monkeypatch.setattr(
        router_node_mod, "detect_attributes", _detect(None, calls=[])
    )
    out = await router_node(
        {
            "user_query": "вопрос", "lang": "ru", "history": [],
            "client_attributes": {"future_thing": {"value": "42"}},
        },
        _Runtime(_Ctx(llm=object())),
    )

    assert "lang" not in out  # nothing language-related was settled
    emitted = _attribute_events(_capture_stream)[0]["data"]
    assert emitted["future_thing"]["value"] == "42"
