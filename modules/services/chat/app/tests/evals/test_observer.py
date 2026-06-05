"""Tests for the eval observer — drives the chat graph with FakeLLM
and verifies that a TurnObservation captures intent + tool_chain +
response_text correctly.

This is the same wiring the live eval runner will use against
OpenRouter; FakeLLM here keeps the test deterministic and free.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, TypeVar

import pytest
from pydantic import BaseModel

from lectorium_chat.agent.graph import build_chat_graph
from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import CompletionChunk, Message
from lectorium_chat.domain.routing import RoutingDecision
from lectorium_chat.agent.graph.turn_context import TurnContext
from tests.evals.observer import observe_turn
from tests.evals.run_chunk_tools_eval import evaluate_case


T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLM:
    """Scripted router (structured_output) + worker/synth (stream)."""

    router_responses: list[RoutingDecision] = field(default_factory=list)
    stream_responses: list[list[CompletionChunk]] = field(default_factory=list)
    _ridx: int = 0
    _sidx: int = 0

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        **_kwargs: Any,
    ) -> T:
        # **_kwargs catches future-added params (e.g. `run_name` for
        # Langfuse span labels) without breaking this mock every time
        # the real LLMPort signature grows.
        resp = self.router_responses[self._ridx]
        self._ridx += 1
        return resp  # type: ignore[return-value]

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        callbacks: list[Any] | None = None,
        **_kwargs: Any,
    ) -> AsyncIterator[CompletionChunk]:
        # **_kwargs catches future-added params (e.g. `run_name` for
        # Langfuse span labels) so this mock survives signature growth.
        chunks = self.stream_responses[self._sidx]
        self._sidx += 1
        for c in chunks:
            yield c


def _tool_call_chunk(*, idx: int, tc_id: str, name: str, args: str) -> CompletionChunk:
    return {
        "tool_calls": [
            {"index": idx, "id": tc_id, "name": name, "arguments_delta": args}
        ]
    }


def _make_ctx(llm: FakeLLM, tools: dict[str, Any]) -> TurnContext:
    aliases = TurnAliasMap()
    return TurnContext(
        request_id="obs-test",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        research_tools=tools,
    )


@pytest.mark.asyncio
async def test_observer_captures_direct_chat_intent() -> None:
    """direct_chat → router runs, no worker, synth answers. Observation
    has intent set, empty tool_chain, response from synth."""
    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="direct_chat", confidence=0.95),
        ],
        stream_responses=[
            [{"text": "Привет! Чем помочь?"}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={})

    obs = await observe_turn("привет", graph=graph, base_ctx=ctx, lang="ru")

    assert obs.intent == "direct_chat"
    assert obs.tool_chain == []
    assert "Привет" in obs.response_text


@pytest.mark.asyncio
async def test_observer_captures_research_tool_chain() -> None:
    """research intent → worker calls a tool → synth answers.
    Observation has intent='research' and tool_chain=[search_x]."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"hits": [{"ref": 42, "text": f"about {q}"}]}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9, extracted_args={"topic": "karma"}),
        ],
        stream_responses=[
            # Worker turn 1: call search_x
            [
                _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "karma"}'),
                {"finish_reason": "stop"},
            ],
            # Worker turn 2: converge
            [{"finish_reason": "stop"}],
            # Synth
            [{"text": "Карма обсуждается в лекциях..."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={"search_x": search_x})

    obs = await observe_turn(
        "найди про карму", graph=graph, base_ctx=ctx, lang="ru"
    )

    assert obs.intent == "research"
    assert obs.confidence == 0.9
    assert obs.tool_names == ["search_x"]
    assert obs.first_tool is not None
    assert obs.first_tool.args == {"q": "karma"}
    assert obs.first_tool.result == {"hits": [{"ref": 42, "text": "about karma"}]}
    assert "Карма" in obs.response_text


@pytest.mark.asyncio
async def test_observer_captures_multi_step_chain_in_order() -> None:
    """Worker calls search_x then search_y — both must appear in
    tool_chain in dispatch order."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"step": "x", "q": q}

    async def search_y(*, q: str) -> dict[str, Any]:
        return {"step": "y", "q": q}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9),
        ],
        stream_responses=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "a"}'), {"finish_reason": "stop"}],
            [_tool_call_chunk(idx=0, tc_id="c2", name="search_y", args='{"q": "b"}'), {"finish_reason": "stop"}],
            [{"finish_reason": "stop"}],  # converge
            [{"text": "done"}, {"finish_reason": "stop"}],  # synth
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={"search_x": search_x, "search_y": search_y})

    obs = await observe_turn("compound", graph=graph, base_ctx=ctx, lang="en")

    assert obs.tool_names == ["search_x", "search_y"]
    assert obs.tool_chain[0].args == {"q": "a"}
    assert obs.tool_chain[1].args == {"q": "b"}


@pytest.mark.asyncio
async def test_observer_into_evaluate_case_full_pipeline() -> None:
    """End-to-end: observe a real-shaped turn → run evaluate_case against
    a real-shaped JSONL case. Covers the integration the live eval
    will use."""

    async def chunks_search(*, query: str, type: str = "verse") -> dict[str, Any]:
        return [{"type": "verse", "ref": 1, "label": "BG 2.13", "text": "..."}]

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.92, extracted_args={"source_id": "BG"}),
        ],
        stream_responses=[
            [
                _tool_call_chunk(
                    idx=0, tc_id="c1", name="chunks_search",
                    args='{"query":"linux-client","type":"verse"}',
                ),
                {"finish_reason": "stop"},
            ],
            [{"finish_reason": "stop"}],
            [{"text": "Найдено в [verse:source_BG/2.13|БГ 2.13]."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={"chunks_search": chunks_search})

    obs = await observe_turn(
        "найди стих про йогу", graph=graph, base_ctx=ctx, lang="ru"
    )

    # Real-shaped case from chunk_tools.jsonl
    case = {
        "query": "найди стих про йогу",
        "expect_intent": "research",
        "expect_tool": "chunks_search",
        "expect_args": {"type": "verse"},
    }
    passed, failures = evaluate_case(case, obs)
    assert passed, f"failures: {failures!r}"
