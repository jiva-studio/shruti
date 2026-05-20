"""SPIKE (throwaway) — verify LangGraph 1.2.0 behaviour we depend on
before committing to the architecture in the plan.

Three empirical questions from the Open Questions list:

  Q#2  Does our `as_langchain_tool` (with `emits_events=True`) propagate
       side events to the SSE writer when invoked inside a graph node?
  Q#3  Are side events ordered BEFORE the next LLM token in the stream
       (so the client renders chip body before the marker arrives)?
  Q#5  Can mutable `TurnAliasMap` be shared by reference across nodes
       via LangGraph's typed `context` API — mutations from node A
       visible in node B?

The tests don't use real LLMs. A scripted fake model produces fixed
tool calls and prose so the graph behavior is fully deterministic.

When this file goes green, the architecture decisions in plan
section 9.4 and section 11 are validated. If anything fails, the
spike report (open question #5) records the fallback.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Annotated, Any, AsyncIterator, Sequence
from uuid import uuid4

import pytest
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.messages.tool import ToolCall
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import StructuredTool, tool
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.runtime import Runtime
from typing_extensions import TypedDict

from shruti_chat.agent.graph.tool_adapter import as_langchain_tool
from shruti_chat.agent.tools._registry import ToolDef
from shruti_chat.agent.turn_aliases import TurnAliasMap


# ── Test fixtures: a scripted fake LLM ────────────────────────────────────


class ScriptedFakeChatModel(BaseChatModel):
    """A BaseChatModel that returns pre-scripted AIMessages in order.

    Each script entry is an AIMessage (with optional tool_calls). The
    model returns them on successive invocations. Tests assert downstream
    behavior — the model itself is deterministic.
    """

    script: list[AIMessage]
    call_idx: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted-fake"

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        if self.call_idx >= len(self.script):
            raise RuntimeError(
                f"scripted model ran out of responses (called {self.call_idx + 1} "
                f"times, script has {len(self.script)} entries)"
            )
        msg = self.script[self.call_idx]
        self.call_idx += 1
        return ChatResult(generations=[ChatGeneration(message=msg)])

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        return self._generate(messages, stop, run_manager, **kwargs)

    class Config:
        arbitrary_types_allowed = True


# ── Q#2: tool side events flow to writer ─────────────────────────────────


@pytest.mark.asyncio
async def test_q2_tool_adapter_emits_side_event_to_writer() -> None:
    """A tool wrapped via as_langchain_tool with emits_events=True must
    push events into LangGraph's custom stream channel. The yield_event
    callback bridges into get_stream_writer at adapter time."""

    captured: list[tuple[str, dict[str, Any]]] = []

    # Tool fn keeps the existing yield_event-callback shape used by our
    # tools/actions.py — adapter forwards into get_stream_writer.
    async def emitter_tool(*, payload: str, yield_event: Any) -> dict[str, Any]:
        yield_event("custom_event", {"echo": payload})
        return {"ok": True, "echoed": payload}

    td = ToolDef(
        name="emitter",
        fn=emitter_tool,
        description="emits a side event then returns",
        parameters={
            "type": "object",
            "properties": {"payload": {"type": "string"}},
            "required": ["payload"],
        },
        emits_events=True,
    )

    # Bridge yield_event → LangGraph writer. This is the shape we'll use
    # in production: chat_turn.py wrapper creates the closure per turn.
    def bridge_yield_event(ev_type: str, data: dict[str, Any]) -> None:
        writer = get_stream_writer()
        writer({"type": ev_type, "data": data})

    lc_tool = as_langchain_tool(td, emitter_tool, yield_event=bridge_yield_event)

    # Minimal graph: one node invokes the tool, returns.
    class State(TypedDict):
        result: str

    async def node(state: State) -> dict:
        out = await lc_tool.ainvoke({"payload": "hello"})
        return {"result": str(out)}

    graph = StateGraph(State).add_node("n", node).add_edge(START, "n").add_edge("n", END).compile()

    async for mode, payload in graph.astream({"result": ""}, stream_mode=["custom", "values"]):
        if mode == "custom":
            captured.append((payload["type"], payload["data"]))

    assert captured == [("custom_event", {"echo": "hello"})], (
        f"expected single custom_event in stream, got {captured!r}"
    )


# ── Q#3: side event ordering BEFORE next LLM token ───────────────────────


@pytest.mark.asyncio
async def test_q3_side_event_arrives_before_next_message_token() -> None:
    """The race we must avoid: side event emits AFTER the LLM has already
    streamed the marker that references it. Client would see the marker
    pointing at unknown data.

    Setup: graph node calls our tool (emits side event), then immediately
    yields its own message via writer. Combined stream must show the
    side event FIRST, then the message.
    """

    order: list[str] = []

    async def emitter_tool(*, q: str, yield_event: Any) -> dict[str, Any]:
        yield_event("verse_payload", {"source": "BG", "tokens": q})
        return {"ok": True}

    td = ToolDef(
        name="verse_lookup",
        fn=emitter_tool,
        description="fetches a verse and emits payload",
        parameters={
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
        },
        emits_events=True,
    )

    def bridge(ev_type: str, data: dict[str, Any]) -> None:
        writer = get_stream_writer()
        writer({"type": ev_type, "data": data})

    lc_tool = as_langchain_tool(td, emitter_tool, yield_event=bridge)

    class State(TypedDict):
        out: str

    async def node(state: State) -> dict:
        await lc_tool.ainvoke({"q": "2.13"})
        # Now write the "marker" that references the verse just emitted.
        writer = get_stream_writer()
        writer({"type": "delta", "data": {"text": "[verse:N|BG 2.13]"}})
        return {"out": "done"}

    graph = StateGraph(State).add_node("n", node).add_edge(START, "n").add_edge("n", END).compile()

    async for mode, payload in graph.astream({"out": ""}, stream_mode=["custom"]):
        if mode == "custom":
            order.append(payload["type"])

    assert order == ["verse_payload", "delta"], (
        f"verse_payload MUST arrive before delta marker; got {order!r}"
    )


# ── Q#5: mutable TurnAliasMap via LangGraph context ──────────────────────


@dataclass
class TurnContext:
    """Per-turn injected services — see plan section 1.7 / 3.

    Mutable. Lives in LangGraph context (typed Runtime). Same instance
    across all nodes within one graph.astream() call.
    """

    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    notes: list[str] = field(default_factory=list)


@pytest.mark.asyncio
async def test_q5_turncontext_mutable_across_nodes_via_context_api() -> None:
    """Node A mints aliases + appends a note via context.aliases /
    context.notes. Node B reads both — must see the mutations as
    references, not as a stale copy.

    This is the key test for the architectural decision in plan
    section 9.4: aliases are "per-turn services" in context, not state.
    """

    class State(TypedDict):
        step: int

    async def node_a(state: State, runtime: Runtime[TurnContext]) -> dict:
        ctx = runtime.context
        ctx.aliases.alias_chunk("track_X", 1500, 2500)
        ctx.aliases.alias_verse("source_BG", "2.13")
        ctx.notes.append("from-a")
        return {"step": 1}

    seen_in_b: dict[str, Any] = {}

    async def node_b(state: State, runtime: Runtime[TurnContext]) -> dict:
        ctx = runtime.context
        seen_in_b["aliases_len"] = len(ctx.aliases)
        seen_in_b["verse_present"] = ctx.aliases.lookup_verse_ref("source_BG", "2.13") is not None
        seen_in_b["chunk_present"] = ctx.aliases.lookup_ref("track_X", 1500, 2500) is not None
        seen_in_b["notes"] = list(ctx.notes)
        ctx.notes.append("from-b")
        return {"step": 2}

    graph = (
        StateGraph(State, context_schema=TurnContext)
        .add_node("a", node_a)
        .add_node("b", node_b)
        .add_edge(START, "a")
        .add_edge("a", "b")
        .add_edge("b", END)
        .compile()
    )

    turn_ctx = TurnContext()
    await graph.ainvoke({"step": 0}, context=turn_ctx)

    # Node B saw the same TurnContext instance — both mutations visible.
    assert seen_in_b["aliases_len"] == 2, f"node B saw {seen_in_b['aliases_len']} aliases, expected 2"
    assert seen_in_b["verse_present"] is True
    assert seen_in_b["chunk_present"] is True
    assert seen_in_b["notes"] == ["from-a"], f"node B saw notes {seen_in_b['notes']!r}"

    # The outer caller also sees mutations done by node B — same instance.
    assert turn_ctx.notes == ["from-a", "from-b"], (
        f"caller-side TurnContext.notes = {turn_ctx.notes!r}; "
        "context object is not shared by reference"
    )
    assert len(turn_ctx.aliases) == 2


# ── Bonus: combined scenario — context + tool + writer ordering ──────────


@pytest.mark.asyncio
async def test_combined_realistic_flow() -> None:
    """Pulls all three together: a node uses context.aliases (Q#5),
    invokes a tool that emits via writer (Q#2), then writes its own
    delta (Q#3 ordering)."""

    @dataclass
    class Ctx:
        aliases: TurnAliasMap = field(default_factory=TurnAliasMap)

    captured: list[str] = []

    async def tool_fn(*, source: str, tokens: str, yield_event: Any) -> dict:
        # In production, build_aliased_tools would mint the alias here.
        # We mint manually for the spike to keep dependencies thin.
        yield_event("alias_minted", {"source": source, "tokens": tokens})
        return {"ok": True, "addr": f"{source} {tokens}"}

    td = ToolDef(
        name="library_lookup",
        fn=tool_fn,
        description="library lookup with alias mint",
        parameters={
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "tokens": {"type": "string"},
            },
            "required": ["source", "tokens"],
        },
        emits_events=True,
    )

    def bridge(ev_type: str, data: dict[str, Any]) -> None:
        writer = get_stream_writer()
        writer({"type": ev_type, "data": data})

    lc_tool = as_langchain_tool(td, tool_fn, yield_event=bridge)

    class State(TypedDict):
        ok: bool

    async def the_node(state: State, runtime: Runtime[Ctx]) -> dict:
        # Step 1: invoke tool — emits "alias_minted"
        await lc_tool.ainvoke({"source": "BG", "tokens": "2.13"})
        # Step 2: mint the alias on the shared map
        n = runtime.context.aliases.alias_verse("source_BG", "2.13", addr_label="BG 2.13")
        # Step 3: write the marker referencing the alias
        writer = get_stream_writer()
        writer({"type": "delta", "data": {"text": f"[verse:{n}|BG 2.13]"}})
        return {"ok": True}

    graph = (
        StateGraph(State, context_schema=Ctx)
        .add_node("n", the_node)
        .add_edge(START, "n")
        .add_edge("n", END)
        .compile()
    )

    ctx = Ctx()
    async for mode, payload in graph.astream({"ok": False}, context=ctx, stream_mode=["custom"]):
        if mode == "custom":
            captured.append(payload["type"])

    assert captured == ["alias_minted", "delta"], (
        f"event ordering broken; got {captured!r}"
    )
    # alias minted in node persists outside
    assert ctx.aliases.lookup_verse_ref("source_BG", "2.13") is not None
