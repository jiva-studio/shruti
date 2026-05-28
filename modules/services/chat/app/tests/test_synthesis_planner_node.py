"""Unit tests for agent.graph.nodes.synthesis_planner."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes.synthesis_planner import (
    synthesis_planner_node,
)
from shruti_chat.research.models import Outline, Thesis


@dataclass
class _Ctx:
    """Minimal stand-in for TurnContext. The node only touches `llm`,
    `request_id`, `langfuse_trace_id`. Real TurnContext has many more
    fields but they're irrelevant to planning."""

    llm: Any | None = None
    request_id: str = "req-test"
    langfuse_trace_id: str = ""


@dataclass
class _Runtime:
    """LangGraph Runtime[TurnContext] subset — the node only reads
    `runtime.context`."""

    context: _Ctx = field(default_factory=_Ctx)


class _LLM:
    """Scripted structured_output that records calls."""

    def __init__(self, script: Any) -> None:
        self.script = script
        self.calls: list[Any] = []

    async def structured_output(self, messages, schema, *, model=None, **_extra):
        self.calls.append((messages, schema, model))
        if callable(self.script):
            return self.script()
        return self.script


@pytest.mark.asyncio
async def test_empty_tool_results_returns_outline_none_skips_llm():
    """No notes → planner skips entirely → outline=None → synthesizer
    falls back to its existing empty-results handling."""
    llm = _LLM(Outline(theses=[]))
    rt = _Runtime(context=_Ctx(llm=llm))
    state = {"user_query": "q", "lang": "ru", "tool_results": []}
    out = await synthesis_planner_node(state, rt)
    assert out == {"outline": None}
    assert llm.calls == []  # LLM never invoked


@pytest.mark.asyncio
async def test_no_llm_returns_outline_none_skips_call():
    """Defensive: a test harness without an LLM should not crash."""
    rt = _Runtime(context=_Ctx(llm=None))
    state = {"user_query": "q", "lang": "ru",
             "tool_results": [{"type": "lecture", "text": "x", "score": 0.7, "meta": {}}]}
    out = await synthesis_planner_node(state, rt)
    assert out == {"outline": None}


@pytest.mark.asyncio
async def test_llm_failure_returns_outline_none_for_graceful_fallback():
    """build_outline absorbs the exception; the node sees `None` and
    propagates it. Synthesizer then runs in free-form mode — no crash."""
    def boom():
        raise RuntimeError("openrouter 503")
    llm = _LLM(boom)
    rt = _Runtime(context=_Ctx(llm=llm))
    state = {"user_query": "q", "lang": "ru",
             "tool_results": [{"type": "lecture", "text": "x", "score": 0.7, "meta": {}}]}
    out = await synthesis_planner_node(state, rt)
    assert out == {"outline": None}


@pytest.mark.asyncio
async def test_writes_outline_when_planner_succeeds():
    outline = Outline(theses=[
        Thesis(thesis="t1", supporting_notes=[1]),
        Thesis(thesis="t2", supporting_notes=[1]),
    ])
    llm = _LLM(outline)
    rt = _Runtime(context=_Ctx(llm=llm))
    state = {"user_query": "q", "lang": "ru",
             "tool_results": [{"type": "lecture", "text": "x", "score": 0.7, "meta": {}}]}
    out = await synthesis_planner_node(state, rt)
    assert out["outline"] is not None
    assert len(out["outline"].theses) == 2


@pytest.mark.asyncio
async def test_writes_outline_with_empty_theses_for_refusal():
    """Planner deliberately rejected all notes → empty Outline travels
    through the node verbatim so synthesizer's refusal-path triggers."""
    outline = Outline(theses=[], skipped_reason="off-topic")
    llm = _LLM(outline)
    rt = _Runtime(context=_Ctx(llm=llm))
    state = {"user_query": "q", "lang": "ru",
             "tool_results": [{"type": "lecture", "text": "x", "score": 0.3, "meta": {}}]}
    out = await synthesis_planner_node(state, rt)
    assert out["outline"] is not None
    assert out["outline"].theses == []
    assert out["outline"].skipped_reason == "off-topic"
