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
        self, messages: list[Message], schema: type[T], *, model: str | None = None
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
async def test_low_confidence_collapses_to_unknown() -> None:
    """Confidence < 0.5 means the router isn't sure — downstream routing
    must treat as unknown so synthesizer takes the soft-fallback path."""
    llm = FakeLLMForRouter(
        responses=[
            RoutingDecision(intent="research", confidence=0.3, extracted_args={"hint": "foo"}),
        ]
    )
    out = await run_router_turn("что-то странное", lang="ru", llm=llm)
    assert out.intent == "unknown"
    assert out.confidence == 0.3
    # Extracted args survive the collapse — they may still be useful
    # to a fallback responder.
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
async def test_lang_is_in_user_message() -> None:
    """The lang tag flows into the user message so the model can use
    it as a soft hint for which language's terminology to favour."""
    llm = FakeLLMForRouter(
        responses=[RoutingDecision(intent="direct_chat", confidence=0.95)]
    )
    await run_router_turn("привет", lang="ru", llm=llm)
    assert len(llm.seen_calls) == 1
    msgs = llm.seen_calls[0]
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert "lang=ru" in msgs[1]["content"]
    assert "привет" in msgs[1]["content"]


@pytest.mark.asyncio
async def test_model_override_passes_through() -> None:
    """When the caller specifies a model (e.g. cheaper-than-default),
    it must reach the LLMPort verbatim."""

    captured_model: list[str | None] = []

    class _LLM:
        async def structured_output(self, messages, schema, *, model=None):
            captured_model.append(model)
            return RoutingDecision(intent="help", confidence=0.9)

    await run_router_turn(
        "что ты умеешь",
        lang="ru",
        llm=_LLM(),
        model="openrouter/google/gemini-3.1-flash-lite",
    )
    assert captured_model == ["openrouter/google/gemini-3.1-flash-lite"]
