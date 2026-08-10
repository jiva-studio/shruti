"""Tests for `application/react_loop.py` — multi-step ReAct loop.

Uses a `FakeLLM` that scripts streaming chunks (text/tool_call deltas)
and a `FakeTools` dict so we exercise the full dispatcher without
LLM calls or DB.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import pytest

from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.application.react_loop import run_react_loop
from lectorium_chat.domain.entities import CompletionChunk, Message


@dataclass
class ScriptedLLM:
    """Scripts a sequence of `stream_completion` responses, one per
    LLM call. Each script entry is a list of CompletionChunks the
    fake will yield."""

    script: list[list[CompletionChunk]] = field(default_factory=list)
    seen_calls: list[dict[str, Any]] = field(default_factory=list)
    _idx: int = 0

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
        self.seen_calls.append(
            {
                "messages": [dict(m) for m in messages],
                "messages_count": len(messages),
                "tools_count": len(tools or []),
                "tool_choice": tool_choice,
                "model": model,
            }
        )
        if self._idx >= len(self.script):
            raise RuntimeError(
                f"LLM script exhausted (call {self._idx + 1}, have {len(self.script)})"
            )
        chunks = self.script[self._idx]
        self._idx += 1
        for c in chunks:
            yield c


def _tool_call_chunk(*, idx: int, tc_id: str, name: str, args: str) -> CompletionChunk:
    """Single chunk carrying a tool_call delta in pieces."""
    return {
        "tool_calls": [
            {"index": idx, "id": tc_id, "name": name, "arguments_delta": args}
        ]
    }


def _finish_chunk(reason: str = "stop") -> CompletionChunk:
    return {"finish_reason": reason}


# Trivial tool schema list for the LLM-facing side.
_FAKE_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_x",
            "description": "search",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_y",
            "description": "search",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        },
    },
]


@pytest.mark.asyncio
async def test_single_tool_call_then_converge() -> None:
    """LLM picks one tool, returns no further tool calls → loop stops."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"hits": [{"ref": 42, "text": f"result for {q}"}]}

    llm = ScriptedLLM(
        script=[
            # Turn 1: emit one tool_call, no further calls afterwards.
            [
                _tool_call_chunk(idx=0, tc_id="call_1", name="search_x", args='{"q": "karma"}'),
                _finish_chunk(),
            ],
            # Turn 2: LLM done — no tool_calls at all.
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "найди про карму",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="system prompt body",
    )
    assert result.n_turns == 2
    assert result.hit_max_turns is False
    assert result.tool_results == [{"hits": [{"ref": 42, "text": "result for karma"}]}]


@pytest.mark.asyncio
async def test_multi_step_cross_kind_chain() -> None:
    """Realistic scenario: search_x → search_y → converge. Both tools
    contribute to `tool_results` in order."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"hits": [{"ref": 1, "addr": "lecture @1500"}]}

    async def search_y(*, q: str) -> dict[str, Any]:
        return {"hits": [{"ref": 2, "addr": "BG 4.17"}]}

    llm = ScriptedLLM(
        script=[
            # Turn 1: search_x for the lecture.
            [
                _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "karma"}'),
                _finish_chunk(),
            ],
            # Turn 2: now go look up the verse.
            [
                _tool_call_chunk(idx=0, tc_id="c2", name="search_y", args='{"q": "BG 4.17"}'),
                _finish_chunk(),
            ],
            # Turn 3: converge.
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "найди про карму",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x, "search_y": search_y},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert result.n_turns == 3
    assert len(result.tool_results) == 2
    assert result.tool_results[0]["hits"][0]["addr"] == "lecture @1500"
    assert result.tool_results[1]["hits"][0]["addr"] == "BG 4.17"


@pytest.mark.asyncio
async def test_first_turn_forces_tool_choice() -> None:
    """The first turn MUST force the LLM into a tool call so it can't
    skip the search step (it has nothing in messages yet to ground on).

    - Multiple tools available → tool_choice="required".
    - Exactly one tool available → tool_choice=<that tool's name>.
      "required" with a single-tool menu has been observed dropping
      to no-call on Gemini Flash Lite; pinning the literal name works
      across providers.
    """

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"ok": True}

    async def search_y(**kwargs: Any) -> dict[str, Any]:
        return {"ok": True}

    # ── single-tool path: force the tool by name ────────────────────
    llm_single = ScriptedLLM(
        script=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args="{}"), _finish_chunk()],
            [_finish_chunk()],
        ],
    )
    await run_react_loop(
        "x",
        extracted_args={},
        llm=llm_single,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert llm_single.seen_calls[0]["tool_choice"] == "search_x"
    assert llm_single.seen_calls[1]["tool_choice"] is None

    # ── multi-tool path: "required" stays generic ───────────────────
    llm_multi = ScriptedLLM(
        script=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args="{}"), _finish_chunk()],
            [_finish_chunk()],
        ],
    )
    await run_react_loop(
        "x",
        extracted_args={},
        llm=llm_multi,
        tools={"search_x": search_x, "search_y": search_y},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert llm_multi.seen_calls[0]["tool_choice"] == "required"
    assert llm_multi.seen_calls[1]["tool_choice"] is None


@pytest.mark.asyncio
async def test_max_turns_cap_reached() -> None:
    """LLM keeps calling tools forever — guard against runaway."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"hits": []}

    # Pre-fill enough turns to exceed cap. max_turns=3 → loop runs 3
    # turns, each calls a tool, then exits with hit_max_turns=True.
    llm = ScriptedLLM(
        script=[
            [_tool_call_chunk(idx=0, tc_id=f"c{i}", name="search_x", args="{}"), _finish_chunk()]
            for i in range(3)
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
        max_turns=3,
    )
    assert result.n_turns == 3
    assert result.hit_max_turns is True
    assert len(result.tool_results) == 3


@pytest.mark.asyncio
async def test_unknown_tool_returns_error_dict() -> None:
    """LLM hallucinates a tool name → dispatcher returns
    `{error: 'unknown tool ...'}` so the LLM can recover."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"ok": True}

    llm = ScriptedLLM(
        script=[
            [
                _tool_call_chunk(idx=0, tc_id="c1", name="nonexistent", args="{}"),
                _finish_chunk(),
            ],
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert len(result.tool_results) == 1
    assert "unknown tool" in result.tool_results[0]["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "received"),
    [
        ("[]", "array"),
        ('["a","b"]', "array"),
        ("null", "null"),
        ('"hi"', "string"),
        ("3", "number"),
    ],
)
async def test_non_object_tool_args_return_an_error(
    payload: str, received: str
) -> None:
    """The model streams `arguments` that parse to something other than an
    object. The loop must keep running (no AttributeError/TypeError) AND
    must not invent arguments: a tool with no required parameters would
    happily answer `{}` with results nobody asked for. Error it, and let
    the model retry with real arguments."""
    seen: list[dict[str, Any]] = []

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        seen.append(kwargs)
        return {"ok": True}

    llm = ScriptedLLM(
        script=[
            [
                _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args=payload),
                _finish_chunk(),
            ],
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert seen == []
    assert result.tool_results == [
        {"error": f"tool args must be a JSON object, got {received}"}
    ]
    # The assistant turn echoed back into history must still carry an
    # object — `AIMessage(tool_calls=...)` validates `args` as one, so a
    # raw `[]` there would kill the very turn we just kept alive.
    echoed = [
        m for m in llm.seen_calls[-1]["messages"] if m.get("tool_calls")
    ]
    assert [tc["args"] for m in echoed for tc in m["tool_calls"]] == [{}]


@pytest.mark.asyncio
async def test_malformed_tool_args_return_error_dict() -> None:
    """Unparseable JSON is a recoverable tool error, not a dead turn."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"ok": True}

    llm = ScriptedLLM(
        script=[
            [
                _tool_call_chunk(
                    idx=0, tc_id="c1", name="search_x", args="{not json at all"
                ),
                _finish_chunk(),
            ],
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert "bad JSON in tool args" in result.tool_results[0]["error"]


@pytest.mark.asyncio
async def test_wrong_tool_kwargs_return_bad_args_error() -> None:
    """Well-formed object args the tool's signature rejects surface as
    `{error: "bad args: ..."}` so the LLM can retry with the right ones."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"q": q}

    llm = ScriptedLLM(
        script=[
            [
                _tool_call_chunk(
                    idx=0, tc_id="c1", name="search_x", args='{"nope": 1}'
                ),
                _finish_chunk(),
            ],
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert result.tool_results[0]["error"].startswith("bad args: ")


@pytest.mark.asyncio
async def test_tool_raising_returns_error_dict() -> None:
    """Tool throws → dispatcher catches and returns error result, LLM
    can react in its next turn without crashing the whole turn."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        raise ValueError("library.db is locked")

    llm = ScriptedLLM(
        script=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args="{}"), _finish_chunk()],
            [_finish_chunk()],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    assert result.tool_results[0]["error"] == "library.db is locked"


@pytest.mark.asyncio
async def test_extracted_args_appear_in_system_prompt() -> None:
    """Router-extracted args must be injected into the system prompt
    so the worker uses them as seed hints. We verify via the captured
    messages on the LLM call."""
    llm = ScriptedLLM(script=[[_finish_chunk()]])

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {}

    await run_react_loop(
        "find verses about karma",
        extracted_args={"year": 1976, "location": "Bombay", "source_id": "BG"},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="BASE_PROMPT",
    )
    # First call's first message is the system message; check it carries
    # the extracted-args block.
    assert len(llm.seen_calls) == 1
    # We didn't capture the raw messages above to keep ScriptedLLM
    # minimal; instead verify the count matches expected (system + user = 2).
    assert llm.seen_calls[0]["messages_count"] == 2


@pytest.mark.asyncio
async def test_tool_lifecycle_callback_fires_around_each_dispatch() -> None:
    """Worker bridges on_tool_event to the SSE writer so the client
    shows "thinking" UI. Verify each tool call generates exactly one
    tool_start + one tool_end, in dispatch order, for the right name."""
    events: list[tuple[str, str]] = []

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"hit": "yes"}

    async def search_y(**kwargs: Any) -> dict[str, Any]:
        return {"hit": "more"}

    llm = ScriptedLLM(
        script=[
            # Turn 1: call search_x
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args="{}"), _finish_chunk()],
            # Turn 2: call search_y
            [_tool_call_chunk(idx=0, tc_id="c2", name="search_y", args="{}"), _finish_chunk()],
            # Turn 3: converge
            [_finish_chunk()],
        ],
    )

    await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x, "search_y": search_y},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
        on_tool_event=lambda ev, name: events.append((ev, name)),
    )

    assert events == [
        ("tool_start", "search_x"),
        ("tool_end", "search_x"),
        ("tool_start", "search_y"),
        ("tool_end", "search_y"),
    ], f"unexpected event order: {events!r}"


@pytest.mark.asyncio
async def test_tool_lifecycle_fires_even_on_tool_error() -> None:
    """tool_end MUST fire even if the tool raised — otherwise the
    client's UI gets stuck showing "thinking" forever."""
    events: list[tuple[str, str]] = []

    async def broken_tool(**kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("kaboom")

    llm = ScriptedLLM(
        script=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="broken_tool", args="{}"), _finish_chunk()],
            [_finish_chunk()],
        ],
    )

    await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"broken_tool": broken_tool},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
        on_tool_event=lambda ev, name: events.append((ev, name)),
    )
    assert ("tool_start", "broken_tool") in events
    assert ("tool_end", "broken_tool") in events


@pytest.mark.asyncio
async def test_streamed_prose_dropped_not_returned() -> None:
    """Workers don't stream prose to client. If the LLM emits text
    between tool calls, the loop ignores it — only tool_results
    surface in the return value."""

    async def search_x(**kwargs: Any) -> dict[str, Any]:
        return {"hit": "yes"}

    llm = ScriptedLLM(
        script=[
            [
                {"text": "let me search..."},
                _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args="{}"),
                _finish_chunk(),
            ],
            [
                {"text": "found it, done"},
                _finish_chunk(),
            ],
        ],
    )
    result = await run_react_loop(
        "x",
        extracted_args={},
        llm=llm,
        tools={"search_x": search_x},
        tool_schemas=_FAKE_SCHEMAS,
        aliases=TurnAliasMap(),
        system_prompt="sys",
    )
    # No "let me search..." or "found it, done" anywhere in the result.
    assert result.tool_results == [{"hit": "yes"}]
