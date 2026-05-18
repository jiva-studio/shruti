"""Streaming agent loop — function-calling with token-level deltas.

Pure orchestration:
- Streams an LLM completion, yielding `delta` events as text arrives.
- Buffers `tool_calls` fragments while they stream in.
- On stream-end with no tool calls → emits `done` and returns.
- On stream-end with tool calls → appends the assistant turn,
  dispatches each tool via `execute_tool_call`, emits the
  `tool_start` / side-event / `tool` bookends, appends each result
  back to the message history, and loops.
- After `max_tool_turns` without a final answer → emits `error`.

The module knows nothing about SQL, S3, or UserContext — those
concerns live in the use-case (`application/chat_turn.py`) which
wires this loop with concrete adapters.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable, Iterable

from lectorium_chat.agent import llm
from lectorium_chat.agent.events import AgentEvent
from lectorium_chat.agent.tool_executor import (
    ToolCallSpec,
    encode_tool_result,
    execute_tool_call,
)
from lectorium_chat.agent.tools._registry import ToolFn
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


# Ceiling on tool-call turns per /chat request. Real-world playlist /
# multi-criteria queries observably need 5-7 turns (resolve_source →
# search_transcripts → list_tracks → resolve_tag → list_tracks → answer).
# 10 leaves comfortable headroom for the agent's exploratory passes
# without inviting runaway loops. Hitting the ceiling surfaces a typed
# error to the client so the UX can render a specific "agent didn't
# converge" message instead of a generic network failure.
MAX_TOOL_TURNS = 10


async def run_llm_loop(
    messages: list[dict[str, Any]],
    *,
    tools: dict[str, ToolFn],
    tool_schemas: list[dict[str, Any]],
    emits_events: Iterable[str],
    lang: str,
    model: str,
    request_id: str | None = None,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    max_tool_turns: int = MAX_TOOL_TURNS,
    on_done: Callable[[str], Awaitable[None]] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Stream tokens, buffer tool calls, dispatch, repeat.

    `messages` is mutated in place across tool turns — the loop appends
    the assistant's tool-call turn and each tool's result. Callers that
    care about the final state can inspect `messages` after iteration.

    `on_done` (optional) is awaited once the loop converges (just
    before yielding the `done` event), with the FULL LLM-authored
    prose accumulated across all tool turns. This is the content the
    LLM typed verbatim — it does NOT include text injected by tools
    (`propose_cite`/`card`/`outline` emit their markers via
    `yield_event` side-channels that bypass `content_buf`). Use the
    hook to log bypass markers without entangling `llm_loop` with
    catalog access.
    """
    rid = request_id or uuid.uuid4().hex[:8]
    total_input_tokens = 0
    total_output_tokens = 0
    tool_calls_made = 0
    started = time.monotonic()
    # LLM prose accumulated across ALL tool turns (per-turn content_buf
    # only holds the current round). The `on_done` hook sees this.
    llm_prose_full: list[str] = []

    async def _client_gone() -> bool:
        return bool(is_disconnected and await is_disconnected())

    try:
        for turn in range(max_tool_turns):
            if await _client_gone():
                log.info("agent_cancelled_pre_turn", request_id=rid, turn=turn)
                return
            t0 = time.monotonic()
            content_buf: list[str] = []
            tool_calls_by_index: dict[int, dict[str, Any]] = {}
            usage = None

            async for chunk in llm.stream_completion(
                model=model, messages=messages, tools=tool_schemas,
            ):
                if await _client_gone():
                    log.info("agent_cancelled_mid_stream", request_id=rid, turn=turn)
                    return
                if not getattr(chunk, "choices", None):
                    continue
                delta = chunk.choices[0].delta
                u = getattr(chunk, "usage", None)
                if u:
                    usage = u

                text_delta = getattr(delta, "content", None)
                if text_delta:
                    content_buf.append(text_delta)
                    llm_prose_full.append(text_delta)
                    yield AgentEvent(type="delta", data={"text": text_delta})

                tc_fragments = getattr(delta, "tool_calls", None) or []
                for tcd in tc_fragments:
                    idx = getattr(tcd, "index", 0) or 0
                    slot = tool_calls_by_index.setdefault(
                        idx,
                        {"id": "", "function": {"name": "", "arguments": ""}},
                    )
                    if getattr(tcd, "id", None):
                        slot["id"] = tcd.id
                    fn = getattr(tcd, "function", None)
                    if fn is not None:
                        if getattr(fn, "name", None):
                            slot["function"]["name"] += fn.name
                        if getattr(fn, "arguments", None):
                            slot["function"]["arguments"] += fn.arguments

            if usage:
                total_input_tokens += getattr(usage, "prompt_tokens", 0) or 0
                total_output_tokens += getattr(usage, "completion_tokens", 0) or 0

            tool_calls = sorted(tool_calls_by_index.items())
            log.info(
                "llm_call",
                request_id=rid,
                model=model,
                input_tokens=(getattr(usage, "prompt_tokens", None) if usage else None),
                output_tokens=(getattr(usage, "completion_tokens", None) if usage else None),
                duration_ms=int((time.monotonic() - t0) * 1000),
                tool_calls=len(tool_calls),
                streamed_chars=sum(len(s) for s in content_buf),
            )

            if not tool_calls:
                log.info(
                    "chat_done",
                    request_id=rid,
                    total_tokens=total_input_tokens + total_output_tokens,
                    tool_calls=tool_calls_made,
                    duration_ms=int((time.monotonic() - started) * 1000),
                )
                if on_done is not None:
                    try:
                        await on_done("".join(llm_prose_full))
                    except Exception as exc:
                        log.warning("on_done_hook_failed", request_id=rid, error=str(exc))
                yield AgentEvent(type="done", data={})
                return

            # The streamed preamble text is a "thinking out loud" prelude
            # ("Я сделаю это через search_transcripts..."); we wipe it
            # client-side on `tool_start`. Feeding it back into the LLM's
            # own history would let it keep narrating its plan forever,
            # so we persist an empty content with the tool_calls only.
            messages.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": slot["id"],
                        "type": "function",
                        "function": {
                            "name": slot["function"]["name"],
                            "arguments": slot["function"]["arguments"],
                        },
                    }
                    for _, slot in tool_calls
                ],
            })

            for _, slot in tool_calls:
                tool_calls_made += 1
                spec = ToolCallSpec(
                    id=slot["id"],
                    name=slot["function"]["name"],
                    arguments_json=slot["function"]["arguments"],
                )
                yield AgentEvent(type="tool_start", data={})
                ex = await execute_tool_call(
                    spec,
                    tools=tools, emits_events=emits_events, lang=lang,
                    request_id=rid,
                )
                for se in ex.side_events:
                    yield se
                yield AgentEvent(type="tool", data={})
                messages.append({
                    "role": "tool",
                    "tool_call_id": spec.id,
                    "content": encode_tool_result(ex.result),
                })

        yield AgentEvent(
            type="error",
            data={
                "code": "max_turns_exceeded",
                "message": f"agent exceeded {max_tool_turns} tool turns",
            },
        )
    except Exception as exc:
        log.exception("agent_loop_failed", request_id=rid, error=str(exc))
        yield AgentEvent(
            type="error",
            data={"code": "agent_error", "message": str(exc)},
        )
