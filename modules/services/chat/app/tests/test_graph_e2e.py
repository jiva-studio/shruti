"""End-to-end test for the chat graph (Stage 1 skeleton).

Wires a `FakeLLM` for the router and another for synthesizer + worker,
then drives the full graph through `astream` and asserts the SSE
stream shape.

Doesn't test individual nodes — that's `test_router_turn.py` /
`test_react_loop.py` / `test_synthesizer_turn.py`. This file
exists to catch wiring regressions: schema mismatches, missing
edges, context plumbing breaks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, TypeVar

import pytest
from pydantic import BaseModel

from shruti_chat.agent.graph import build_chat_graph
from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import CompletionChunk, Message
from shruti_chat.application.followup_rewrite import FollowupRewrite
from shruti_chat.domain.routing import RoutingDecision
from shruti_chat.agent.graph.turn_context import TurnContext


T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLM:
    """Both structured_output (router) and stream_completion (workers,
    synth) on one fake. Each method has its own script."""

    router_responses: list[RoutingDecision] = field(default_factory=list)
    stream_responses: list[list[CompletionChunk]] = field(default_factory=list)
    _ridx: int = 0
    _sidx: int = 0
    seen_streams: list[dict[str, Any]] = field(default_factory=list)

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        # The pre-router follow-up rewrite shares this LLM. Return an empty
        # passthrough (→ caller keeps the original query) WITHOUT consuming a
        # scripted router_response, so the router script stays in sequence.
        if schema is FollowupRewrite:
            return FollowupRewrite(query="")  # type: ignore[return-value]
        resp = self.router_responses[self._ridx]
        self._ridx += 1
        assert isinstance(resp, schema)
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
        run_name: str | None = None,
    ) -> AsyncIterator[CompletionChunk]:
        self.seen_streams.append(
            {
                "messages_count": len(messages),
                "tools_count": len(tools or []),
                "tool_choice": tool_choice,
                "messages": list(messages),
            }
        )
        chunks = self.stream_responses[self._sidx]
        self._sidx += 1
        for c in chunks:
            yield c


def _make_ctx(llm: FakeLLM) -> TurnContext:
    aliases = TurnAliasMap()
    return TurnContext(
        request_id="test-req",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        research_tools={},
    )


@pytest.mark.asyncio
async def test_direct_chat_skips_worker() -> None:
    """Router returns intent=direct_chat → graph goes
    router → synthesizer (no worker)."""
    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="direct_chat", confidence=0.95),
        ],
        stream_responses=[
            # Only synthesizer stream — no worker call.
            [{"text": "Привет! Чем могу помочь?"}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()

    deltas: list[str] = []
    async for mode, payload in graph.astream(
        {"history": [], "user_query": "привет", "lang": "ru", "request_id": "r1"},
        context=_make_ctx(llm),
        stream_mode=["custom"],
    ):
        if mode == "custom" and payload.get("type") == "delta":
            deltas.append(payload["data"]["text"])

    assert "".join(deltas) == "Привет! Чем могу помочь?"
    # Only synth called the LLM stream (worker skipped).
    assert len(llm.seen_streams) == 1


@pytest.mark.asyncio
async def test_research_intent_runs_worker_then_synth() -> None:
    """Router → research_worker → synthesizer. Worker converges on
    turn 1 (no tool calls), synth streams the answer."""

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9, extracted_args={"topic": "karma"}),
        ],
        stream_responses=[
            # research_worker turn 1: LLM emits no tool calls →
            # immediate convergence (we treat empty research as OK
            # for the wiring test; the use-case test covers tool dispatch).
            [{"finish_reason": "stop"}],
            # synth: streams response.
            [{"text": "В лекциях Прабхупада ..."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm)

    deltas: list[str] = []
    async for mode, payload in graph.astream(
        {"history": [], "user_query": "найди про карму", "lang": "ru", "request_id": "r2"},
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom" and payload.get("type") == "delta":
            deltas.append(payload["data"]["text"])

    assert "В лекциях Прабхупада" in "".join(deltas)
    # Both worker + synth called the LLM.
    assert len(llm.seen_streams) == 2
    # Worker's first stream call had tool_choice=required pinned.
    assert llm.seen_streams[0]["tool_choice"] == "required"
    # Synth's stream call had no tools.
    assert llm.seen_streams[1]["tools_count"] == 0


@pytest.mark.asyncio
async def test_tool_events_reach_sse_stream() -> None:
    """The worker bridges its tool_start/tool_end callbacks into the
    LangGraph writer. Verify the SSE stream carries `tool_start` and
    `tool` events around the actual tool dispatch."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"hit": "yes"}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9),
        ],
        stream_responses=[
            # Worker turn 1: call search_x
            [
                {
                    "tool_calls": [
                        {"index": 0, "id": "c1", "name": "search_x", "arguments_delta": "{}"}
                    ]
                },
                {"finish_reason": "stop"},
            ],
            # Worker turn 2: converge
            [{"finish_reason": "stop"}],
            # Synth stream
            [{"text": "Ответ."}, {"finish_reason": "stop"}],
        ],
    )

    graph = build_chat_graph()
    aliases = TurnAliasMap()
    ctx = TurnContext(
        request_id="r-tool",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        research_tools={"search_x": search_x},
    )

    events: list[tuple[str, dict[str, Any]]] = []
    async for mode, payload in graph.astream(
        {"history": [], "user_query": "найди что-то", "lang": "ru", "request_id": "r-tool"},
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom":
            events.append((payload.get("type"), payload.get("data", {})))

    types = [t for t, _ in events]
    # tool_start and tool_end both fire around search_x.
    assert "tool_start" in types, f"no tool_start in {types!r}"
    assert "tool_end" in types, f"no tool_end in {types!r}"

    # tool_start must come BEFORE the delta marker (UI ordering).
    first_tool_start = types.index("tool_start")
    first_delta = types.index("delta") if "delta" in types else len(types)
    assert first_tool_start < first_delta, (
        f"tool_start ({first_tool_start}) must precede first delta ({first_delta})"
    )

    # Payload carries the tool name so client can show contextual label.
    tool_start_event = next(d for t, d in events if t == "tool_start")
    assert tool_start_event.get("name") == "search_x"


@pytest.mark.asyncio
async def test_unknown_intent_routes_through_light_research() -> None:
    """#39: an `unknown` intent no longer drops straight to a tool-less
    synthesizer. It runs a LIGHT research pass first (research_worker →
    synthesis_planner → synthesizer) so a single misclassification can't
    yield a confident "not found" with retrieval skipped — the worker
    grounds the answer or honestly comes up empty, then synth phrases it.
    """
    llm = FakeLLM(
        router_responses=[
            # Model itself returns `unknown` — a genuinely ambiguous query
            # (NOT a downgraded research; #36 keeps retrieval intents whole).
            RoutingDecision(intent="unknown", confidence=0.3),
        ],
        stream_responses=[
            # research_worker turn 1: no tool calls → immediate convergence
            # (empty research is fine for this wiring test).
            [{"finish_reason": "stop"}],
            # synth: streams the phrased result.
            [{"text": "Не уверен, что нашёл. Попробуй уточнить."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm)

    deltas: list[str] = []
    async for mode, payload in graph.astream(
        {"history": [], "user_query": "abracadabra", "lang": "ru", "request_id": "r3"},
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom" and payload.get("type") == "delta":
            deltas.append(payload["data"]["text"])

    assert "уточнить" in "".join(deltas)
    # The light research pass ran: research_worker LLM call + synth call.
    assert len(llm.seen_streams) == 2
    assert llm.seen_streams[0]["tool_choice"] == "required"
    assert llm.seen_streams[1]["tools_count"] == 0


@pytest.mark.asyncio
async def test_action_yield_event_reaches_sse_stream() -> None:
    """Regression for the action-emission bug.

    Tools registered with `emits_events=True` (track_pdf_generate,
    reminder_propose, etc.) accept a `yield_event(type, data)` kwarg
    — that's how they push the matching SSE `action` event to the
    client. The new graph's dispatcher
    (`application/react_loop._dispatch_tool_call`) must inject a
    writer-bound callback for those tools, or the
    `[action:<kind>|id=…]` marker the LLM later writes renders as
    a broken card on mobile.

    Mirrors how a real propose_* tool fires its action event:
    receives `yield_event` kwarg, calls it with
    `("action", {kind, id, payload})`, returns the action_id.
    """

    async def fake_track_pdf_generate(**kwargs: Any) -> dict[str, Any]:
        yield_event = kwargs.get("yield_event")
        assert yield_event is not None, (
            "yield_event must be injected by the dispatcher for tools "
            "in EMITS_EVENTS — without it the SSE action event never "
            "leaves the server"
        )
        yield_event(
            "action",
            {
                "kind": "share_pdf",
                "id": "act_abc123",
                "payload": {"track_ids": ["t1", "t2"]},
            },
        )
        return {"ok": True, "action_id": "act_abc123"}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9),
        ],
        stream_responses=[
            # Worker turn 1: call track_pdf_generate
            [
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "tc1",
                            "name": "track_pdf_generate",
                            "arguments_delta": '{"track_ids":["t1","t2"],"lang":"ru"}',
                        }
                    ]
                },
                {"finish_reason": "stop"},
            ],
            # Worker turn 2: converge
            [{"finish_reason": "stop"}],
            # Synth stream
            [{"text": "Готов PDF."}, {"finish_reason": "stop"}],
        ],
    )

    graph = build_chat_graph()
    aliases = TurnAliasMap()
    # Important: place the tool in `research_tools` because the test
    # routes through research_worker (router intent=research). The bug
    # was symmetric across worker types — fixing it in
    # `_dispatch_tool_call` covers every worker that calls
    # `run_react_loop`, so testing one worker is sufficient.
    ctx = TurnContext(
        request_id="r-action",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        research_tools={"track_pdf_generate": fake_track_pdf_generate},
    )

    events: list[tuple[str, dict[str, Any]]] = []
    async for mode, payload in graph.astream(
        {
            "history": [],
            "user_query": "сохрани в pdf",
            "lang": "ru",
            "request_id": "r-action",
        },
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom":
            events.append((payload.get("type"), payload.get("data", {})))

    action_events = [data for typ, data in events if typ == "action"]
    assert len(action_events) == 1, (
        f"expected exactly one action SSE event, got {len(action_events)}; "
        f"all event types: {[t for t, _ in events]!r}"
    )
    action = action_events[0]
    assert action["kind"] == "share_pdf"
    assert action["id"] == "act_abc123"
    # Nested payload shape per SSE v1 (plan §11.3).
    assert action["payload"]["track_ids"] == ["t1", "t2"]


@pytest.mark.asyncio
async def test_recap_current_lecture_outline_reaches_synth() -> None:
    """Regression for the «Перескажи текущую лекцию» empty-result refusal
    (PR #1016).

    Router classifies the deictic recap as `research` + `current_ref`; with
    a `current_track_ref` anchor set, `route_after_router` sends it to the
    catalog_worker. The worker calls `track_outline_get`, which emits the
    `outline` action card and returns `{track_id, lang, items:[{start_ms,
    title}]}` — a shape with NO `ref` and NO `text`.

    The bug: `_render_one_note` had no branch for that shape, so it rendered
    to an EMPTY string, the synthesizer's RESEARCH NOTES block came out blank,
    and the empty-result discipline fired a canned refusal — even though the
    recap data was present. This test pins the full seam end-to-end: the
    outline titles must reach the SYNTHESIZER's prompt as grounding, and the
    `[outline:<id>]` marker directive must be there for it to emit the card.
    """
    track_id = "track_xCUy8kQJkgXM"
    titles = [
        "Методы и уровни преданного служения",
        "Природа души и ее связь с Богом",
    ]

    async def fake_track_outline_get(**kwargs: Any) -> dict[str, Any]:
        yield_event = kwargs.get("yield_event")
        items = [
            {"start_ms": 59000, "title": titles[0]},
            {"start_ms": 688000, "title": titles[1]},
        ]
        if yield_event is not None:
            yield_event(
                "action",
                {
                    "kind": "outline",
                    "id": f"outline_{track_id}",
                    "payload": {"track_id": track_id, "items": items},
                },
            )
        return {"track_id": track_id, "lang": "ru", "items": items}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(
                intent="research", confidence=1.0,
                extracted_args={"current_ref": True},
            ),
        ],
        stream_responses=[
            # catalog_worker turn 1: call track_outline_get.
            [
                {
                    "tool_calls": [
                        {
                            "index": 0, "id": "oc1", "name": "track_outline_get",
                            "arguments_delta": f'{{"track_id":"{track_id}"}}',
                        }
                    ]
                },
                {"finish_reason": "stop"},
            ],
            # catalog_worker turn 2: converge.
            [{"finish_reason": "stop"}],
            # synth: a real model would summarise the titles + drop the
            # marker; script that so we can assert the SSE carries it.
            [{"text": f"В этой лекции обсуждается природа души.\n\n[outline:{track_id}]"},
             {"finish_reason": "stop"}],
        ],
    )

    graph = build_chat_graph()
    aliases = TurnAliasMap()
    ctx = TurnContext(
        request_id="r-recap",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        catalog_tools={"track_outline_get": fake_track_outline_get},
    )

    events: list[tuple[str, dict[str, Any]]] = []
    async for mode, payload in graph.astream(
        {
            "history": [],
            "user_query": "Перескажи текущую лекцию",
            "lang": "ru",
            "request_id": "r-recap",
            # chat_turn pre-mints this from user_context.current_track_id;
            # the anchor is what routes research+current_ref → catalog_worker.
            "current_track_ref": 1,
        },
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom":
            events.append((payload.get("type"), payload.get("data", {})))

    # The catalog_worker ran and the outline card fired.
    actions = [d for t, d in events if t == "action"]
    assert any(a.get("kind") == "outline" for a in actions), (
        f"no outline action; event types: {[t for t, _ in events]!r}"
    )

    # THE regression assertion: the synthesizer received the outline titles
    # as grounding (non-empty RESEARCH NOTES) — before the fix this prompt
    # held an empty notes block and the synth refused.
    synth_call = next(s for s in llm.seen_streams if s["tools_count"] == 0)
    synth_system = synth_call["messages"][0]["content"]
    assert "RESEARCH NOTES" in synth_system
    for title in titles:
        assert title in synth_system, (
            f"outline title {title!r} missing from synthesizer grounding — "
            "the worker→synth handoff dropped the outline result"
        )
    # The synth is told which marker to emit for the interactive card.
    assert f"[outline:{track_id}]" in synth_system

    # And the marker survives into the streamed answer.
    deltas = "".join(d.get("text", "") for t, d in events if t == "delta")
    assert f"[outline:{track_id}]" in deltas


@pytest.mark.asyncio
async def test_action_worker_resolves_prior_track_refs_for_pdf() -> None:
    """Regression for the «PDF этих лекций» multi-turn failure.

    The user's prior assistant message held `[card:track_A]` /
    `[card:track_B]` markers. `fold_history` strips them — so when
    the next turn asks "Сделай PDF этих лекций", the action node must
    recover what "этих" referred to from the RAW history.

    The action node is DETERMINISTIC (no LLM): it extracts the prior
    track_ids from history, aliases them into the current turn, and
    calls the aliased `track_pdf_generate` with the integer refs — the
    aliased_tools wrapper de-aliases back to the real catalog ids.

    This test pins the wiring: with no anchor / gather, the node falls
    through to the prior-turn refs and the tool sees the real track ids
    `["track_A", "track_B"]`.
    """
    captured: dict[str, Any] = {}

    async def fake_track_pdf_generate(**kwargs: Any) -> dict[str, Any]:
        captured["track_ids"] = kwargs.get("track_ids")
        yield_event = kwargs.get("yield_event")
        if yield_event is not None:
            yield_event(
                "action",
                {"kind": "share_pdf", "id": "act_pdf", "payload": {"items": []}},
            )
        return {
            "ok": True,
            "kind": "share_pdf",
            "action_id": "act_pdf",
            "items": [],
            "errors": [],
        }

    from shruti_chat.agent.aliased_tools import build_aliased_tools

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="create_action", confidence=0.95),
        ],
        stream_responses=[
            # research_worker (the gather): no tools, just converge — it
            # finds nothing, so the action node falls through to the
            # prior-turn refs.
            [{"finish_reason": "stop"}],
            # action_worker is deterministic now — no LLM turn here.
            # Synth: copies the action marker the deterministic node produced.
            [{"text": "Готовлю PDF.\n[action:share_pdf|id=act_pdf]"},
             {"finish_reason": "stop"}],
        ],
    )

    graph = build_chat_graph()
    aliases = TurnAliasMap()
    # Wrap fake tool through aliased_tools so the integer→track_id
    # translation actually happens (this is the load-bearing piece).
    action_tools = build_aliased_tools(
        {"track_pdf_generate": fake_track_pdf_generate}, aliases,
    )
    ctx = TurnContext(
        request_id="r-pdf",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        action_tools=action_tools,
    )

    async for _ in graph.astream(
        {
            "history": [
                {"role": "user", "content": "плейлист по второй главе"},
                {
                    "role": "assistant",
                    "content": (
                        "Вот лекции:\n"
                        "[card:track_A]\n"
                        "[card:track_B]"
                    ),
                },
                {"role": "user", "content": "Сделай PDF этих лекций"},
            ],
            "user_query": "Сделай PDF этих лекций",
            "lang": "ru",
            "request_id": "r-pdf",
        },
        context=ctx,
        stream_mode=["custom"],
    ):
        pass

    # Tool received the REAL catalog track_ids — not the integer
    # refs the LLM wrote, not invented strings.
    assert captured["track_ids"] == ["track_A", "track_B"], captured
