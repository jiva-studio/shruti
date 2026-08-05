"""Tests for `application/router_turn.py` — pure use-case, no LangGraph.

A `FakeLLM` returns scripted `RoutingDecision` instances so we test
the use-case's wiring (prompt assembly, low-confidence fallback,
logging fields) without paying for real model calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypeVar

import pytest
from pydantic import BaseModel

from lectorium_chat.application.router_turn import run_router_turn
from lectorium_chat.domain.entities import Message
from lectorium_chat.domain.routing import RoutingDecision


T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLMForRouter:
    """Returns the next pre-scripted response on each `structured_output`
    call. Tracks the messages passed in for prompt-assembly assertions."""

    responses: list[RoutingDecision] = field(default_factory=list)
    seen_calls: list[list[Message]] = field(default_factory=list)
    _idx: int = 0

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        self.seen_calls.append(messages)
        if self._idx >= len(self.responses):
            raise RuntimeError("FakeLLM ran out of scripted responses")
        resp = self.responses[self._idx]
        self._idx += 1
        assert isinstance(resp, schema), f"scripted response is not a {schema.__name__}"
        return resp  # type: ignore[return-value]


@pytest.mark.asyncio
async def test_router_returns_decision_verbatim_when_confident() -> None:
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(intent="research", confidence=0.9, extracted_args={"year": 1976}),
        ]
    )
    out = await run_router_turn("найди про карму", lang="ru", llm=llm)
    assert out.intent == "research"
    assert out.confidence == 0.9
    assert out.extracted_args == {"year": 1976}


@pytest.mark.asyncio
async def test_low_confidence_small_talk_collapses_to_unknown() -> None:
    """`direct_chat` is the one intent whose worker does NOTHING, so an unsure
    guess there answers a real question with small talk. Collapsing sends it
    through the light research pass instead."""
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(
                intent="direct_chat", confidence=0.3, extracted_args={"hint": "foo"},
            ),
        ]
    )
    out = await run_router_turn("что-то странное", lang="ru", llm=llm)
    assert out.intent == "unknown"
    assert out.confidence == 0.3
    # Extracted args survive the collapse — they may still be useful
    # to a fallback responder.
    assert out.extracted_args == {"hint": "foo"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "intent",
    ["help", "create_action", "add-to-library", "recommend", "show_verse"],
)
async def test_an_unsure_intent_still_reaches_the_worker_that_serves_it(
    intent: str,
) -> None:
    """Being unsure is not a reason to route somewhere that cannot help.

    Each of these lost something concrete to the old collapse: `help` answered
    from the lecture corpus AND stopped being quota-exempt (the API reads the
    intent after this rewrite); `create_action` broke the research→action chain
    that compares against the literal "create_action", so no PDF card was ever
    produced; `add-to-library` landed on the corpus-only path its own prompt
    forbids; `recommend` semantic-searched «что мне послушать дальше»;
    `show_verse` lost the verse card."""
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(
                intent=intent, confidence=0.3, extracted_args={"hint": "foo"},
            ),
        ]
    )
    out = await run_router_turn("что-то странное", lang="ru", llm=llm)
    assert out.intent == intent
    assert out.extracted_args == {"hint": "foo"}


@pytest.mark.asyncio
async def test_low_confidence_research_is_preserved() -> None:
    """#36: a low-confidence retrieval-bearing intent (research / locate /
    find_track) must NOT collapse to `unknown`. Flattening it would send
    the turn to a tool-less synthesizer that confidently answers "not
    found" with retrieval skipped (the `router_unknown_misroute` class).
    A slightly-unsure research is still far better served by running the
    search — the worker grounds it or honestly comes up empty."""
    for intent in ("research", "locate", "find_track"):
        llm = FakeLLMForRouter(
            responses=[
                RoutingDecision(
                    intent=intent, confidence=0.3, extracted_args={"hint": "foo"},
                ),
            ]
        )
        out = await run_router_turn("что-то странное", lang="ru", llm=llm)
        assert out.intent == intent, f"{intent} must survive the low-conf collapse"
        assert out.confidence == 0.3
        assert out.extracted_args == {"hint": "foo"}


@pytest.mark.asyncio
async def test_unknown_stays_unknown_below_threshold() -> None:
    """If the model itself returned unknown with low confidence, we
    don't double-stamp — just pass through."""
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(intent="unknown", confidence=0.2),
        ]
    )
    out = await run_router_turn("...", lang="en", llm=llm)
    assert out.intent == "unknown"
    assert out.confidence == 0.2


@pytest.mark.asyncio
async def test_lang_substituted_into_system_prompt() -> None:
    """`lang` is substituted into the `{{LANG}}` placeholder in the
    router prompt (system message) instead of being prefixed onto the
    user message — keeps the directive close to the rule that uses
    it, no per-turn user-content noise."""
    llm = FakeLLMForRouter(
        responses=[RoutingDecision(intent="direct_chat", confidence=0.95)]
    )
    await run_router_turn("привет", lang="ru", llm=llm)
    assert len(llm.seen_calls) == 1
    msgs = llm.seen_calls[0]
    assert msgs[0]["role"] == "system"
    assert "{{LANG}}" not in msgs[0]["content"]
    assert "`ru`" in msgs[0]["content"] or "ru\n" in msgs[0]["content"]
    assert msgs[1]["role"] == "user"
    # The user message is the clean query; the player-context hint rides on the
    # trusted SYSTEM message (so the user can't forge it).
    assert msgs[1]["content"] == "привет"
    assert "[turn-context:" in msgs[0]["content"]


@pytest.mark.asyncio
async def test_prior_refs_flag_adds_context_hint_to_user_message() -> None:
    """A deictic follow-up ("эту") is ambiguous on the latest message
    alone. When the prior turn surfaced refs, the [turn-context] line in the
    system message says so; with no prior refs that clause is omitted (the line
    still carries the player-context bits). The user message stays clean."""
    llm = FakeLLMForRouter(
        responses=[RoutingDecision(intent="research", confidence=0.9)]
    )
    await run_router_turn("эту", lang="ru", llm=llm, prior_turn_had_refs=True)
    sys_msg, user_msg = llm.seen_calls[0][0]["content"], llm.seen_calls[0][1]["content"]
    assert user_msg == "эту"
    assert "previous answer offered" in sys_msg

    llm2 = FakeLLMForRouter(
        responses=[RoutingDecision(intent="research", confidence=0.9)]
    )
    await run_router_turn("эту", lang="ru", llm=llm2, prior_turn_had_refs=False)
    assert "previous answer offered" not in llm2.seen_calls[0][0]["content"]


@pytest.mark.asyncio
async def test_player_context_bits_surface_in_hint() -> None:
    """The router message states the player state so the classifier sets
    deictic flags consistently with reality (nothing open / no history)."""
    llm = FakeLLMForRouter(
        responses=[RoutingDecision(intent="research", confidence=0.9)]
    )
    await run_router_turn(
        "перескажи текущую", lang="ru", llm=llm,
        has_current_track=True, has_recent_history=False,
    )
    sys_msg = llm.seen_calls[0][0]["content"]  # hint is on the system message
    assert "a lecture is currently open" in sys_msg
    assert "NO listening history" in sys_msg

    llm2 = FakeLLMForRouter(
        responses=[RoutingDecision(intent="research", confidence=0.9)]
    )
    await run_router_turn("привет", lang="ru", llm=llm2)  # defaults: both False
    sys_msg2 = llm2.seen_calls[0][0]["content"]
    assert "no lecture is currently open" in sys_msg2
    assert "NO listening history" in sys_msg2


@pytest.mark.asyncio
async def test_prior_refs_flag_separates_cache_entries() -> None:
    """Same text + lang + model but different prior-refs context must NOT
    collide in the router cache — each gets its own LLM call + entry."""
    from lectorium_chat.infra.cache.memory_kv_cache import MemoryKVCache

    cache = MemoryKVCache()
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(intent="research", confidence=0.9),
            RoutingDecision(intent="create_action", confidence=0.9),
        ]
    )
    a = await run_router_turn(
        "а PDF?", lang="ru", llm=llm, kv_cache=cache, prior_turn_had_refs=False,
    )
    b = await run_router_turn(
        "а PDF?", lang="ru", llm=llm, kv_cache=cache, prior_turn_had_refs=True,
    )
    # Two distinct LLM calls (no cross-context cache hit) → the second
    # decision is the second scripted response, not the first.
    assert len(llm.seen_calls) == 2
    assert a.intent == "research"
    assert b.intent == "create_action"
    # And a repeat of the FIRST context DOES hit cache (no 3rd call).
    a2 = await run_router_turn(
        "а PDF?", lang="ru", llm=llm, kv_cache=cache, prior_turn_had_refs=False,
    )
    assert len(llm.seen_calls) == 2
    assert a2.intent == "research"


@pytest.mark.asyncio
async def test_model_override_passes_through() -> None:
    """When the caller specifies a model (e.g. cheaper-than-default),
    it must reach the LLMPort verbatim."""

    captured_model: list[str | None] = []

    class _LLM:
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            captured_model.append(model)
            return RoutingDecision(intent="help", confidence=0.9)

    await run_router_turn(
        "что ты умеешь",
        lang="ru",
        llm=_LLM(),
        model="openrouter/google/gemini-3.1-flash-lite",
    )
    assert captured_model == ["openrouter/google/gemini-3.1-flash-lite"]
