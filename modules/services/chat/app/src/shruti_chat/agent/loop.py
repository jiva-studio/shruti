"""Agent loop — function-calling with token-level streaming.

Every LLM call is streamed: text deltas are yielded immediately so the
client gets a typing-effect render, while tool_call fragments are buffered
and dispatched only once the stream completes. Up to MAX_TOOL_TURNS rounds.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator

from shruti_chat.agent import llm
from shruti_chat.agent.prompts import SYSTEM_PROMPT
from shruti_chat.agent.tools import TOOL_SCHEMAS, TOOLS
from shruti_chat.config import get_settings
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

MAX_TOOL_TURNS = 5


@dataclass
class AgentEvent:
    """Either a text delta, tool-call notification, done, or error."""

    type: str  # 'delta' | 'tool' | 'done' | 'error'
    data: dict[str, Any]


_LANG_NAME = {"ru": "Russian", "en": "English"}
_LANG_EXAMPLE = {
    "ru": (
        "User: «Дай список лекций про политику»\n"
        "WRONG (in English): \"The search for 'politics' yields...\"\n"
        "RIGHT (in Russian): «Вот несколько лекций о политике:» followed by [card:...] markers."
    ),
    "en": (
        "User: \"Give me lectures on politics\"\n"
        "WRONG (in Russian): «Поиск по слову 'политика' дал...»\n"
        "RIGHT (in English): \"Here are some lectures on politics:\" followed by [card:...] markers."
    ),
}


def _make_messages(history: list[dict[str, Any]], lang: str) -> list[dict[str, Any]]:
    lang_name = _LANG_NAME.get(lang, lang)
    lang_directive = (
        "\n\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        f"RESPONSE LANGUAGE — STRICT — REPLY ONLY IN {lang_name.upper()}\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        f"\nThe user's interface language is {lang_name} ({lang}). EVERY sentence "
        f"of your reply prose MUST be written in {lang_name}. Do not switch "
        "languages mid-response. Do not narrate in English what you'll do "
        f"if the user wrote in {lang_name}. Tool search queries may be in any "
        f"language that improves recall, but your visible reply text is "
        f"{lang_name}-only.\n\n"
        f"{_LANG_EXAMPLE.get(lang, '')}\n"
    )
    sys = {"role": "system", "content": SYSTEM_PROMPT + lang_directive}
    # Strip any non-standard fields from history (defensive)
    clean = [{"role": m["role"], "content": m["content"]} for m in history
             if m.get("role") in ("user", "assistant") and m.get("content")]
    return [sys, *clean]


async def run_agent(
    history: list[dict[str, Any]],
    lang: str = "ru",
    request_id: str | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run the agent and yield AgentEvents."""
    settings = get_settings()
    rid = request_id or uuid.uuid4().hex[:8]
    messages = _make_messages(history, lang)

    total_input_tokens = 0
    total_output_tokens = 0
    tool_calls_made = 0
    started = time.monotonic()

    try:
        for turn in range(MAX_TOOL_TURNS):
            t0 = time.monotonic()
            content_buf: list[str] = []
            tool_calls_by_index: dict[int, dict[str, Any]] = {}
            usage = None

            async for chunk in llm.stream_completion(
                model=settings.llm_default,
                messages=messages,
                tools=TOOL_SCHEMAS,
            ):
                if not getattr(chunk, "choices", None):
                    continue
                delta = chunk.choices[0].delta
                # Token usage usually arrives only on the last chunk.
                u = getattr(chunk, "usage", None)
                if u:
                    usage = u

                # Stream text content immediately.
                text_delta = getattr(delta, "content", None)
                if text_delta:
                    content_buf.append(text_delta)
                    yield AgentEvent(type="delta", data={"text": text_delta})

                # Accumulate tool_calls — they arrive in fragments.
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
                model=settings.llm_default,
                input_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
                output_tokens=getattr(usage, "completion_tokens", None) if usage else None,
                duration_ms=int((time.monotonic() - t0) * 1000),
                tool_calls=len(tool_calls),
                streamed_chars=sum(len(s) for s in content_buf),
            )

            if not tool_calls:
                # Final answer was streamed; nothing more to do.
                yield AgentEvent(
                    type="done",
                    data={
                        "request_id": rid,
                        "total_tokens": total_input_tokens + total_output_tokens,
                        "tool_calls": tool_calls_made,
                        "duration_ms": int((time.monotonic() - started) * 1000),
                    },
                )
                return

            # Persist the assistant turn that requested tools. The text
            # streamed BEFORE the tool call is a "thinking preamble"
            # ("Давайте найдём… Я сделаю это с помощью search_transcripts…")
            # that we wipe client-side on the tool event — feeding it back
            # into the LLM's own history would let it keep narrating its
            # plan in subsequent turns. Empty content keeps the function-
            # calling structure intact without polluting the conversation.
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
                    } for _, slot in tool_calls
                ],
            })

            # Dispatch every tool call.
            for _, slot in tool_calls:
                tool_calls_made += 1
                name = slot["function"]["name"]
                tc_id = slot["id"]
                try:
                    args = json.loads(slot["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                # Default `lang` on language-sensitive tools to the request's
                # language unless the model explicitly picked one. Reasoning:
                # a Russian speaker asking «что Прабхупада говорил про X»
                # almost always wants Russian transcripts / Russian-titled
                # lecture cards. To broaden cross-lingually, the model passes
                # lang=null explicitly or lang="en".
                if name in ("search_transcripts", "list_tracks") and "lang" not in args:
                    args["lang"] = lang
                fn = TOOLS.get(name)
                if fn is None:
                    result: Any = {"error": f"unknown tool {name!r}"}
                    result_count = 0
                    duration_ms = 0
                else:
                    t1 = time.monotonic()
                    try:
                        result = await fn(**args)
                    except TypeError as exc:
                        result = {"error": f"bad args: {exc}"}
                        result_count = 0
                    except Exception as exc:
                        log.exception("tool_call_error", tool=name, error=str(exc))
                        result = {"error": str(exc)}
                        result_count = 0
                    else:
                        result_count = len(result) if isinstance(result, list) else 1
                    duration_ms = int((time.monotonic() - t1) * 1000)
                    log.info(
                        "tool_call",
                        request_id=rid,
                        tool_name=name,
                        args=args,
                        duration_ms=duration_ms,
                        result_count=result_count,
                    )

                yield AgentEvent(
                    type="tool",
                    data={
                        "name": name,
                        "duration_ms": duration_ms,
                        "result_count": result_count,
                    },
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": json.dumps(result, ensure_ascii=False, default=str),
                })

        # We hit MAX_TOOL_TURNS without a final answer.
        yield AgentEvent(
            type="error",
            data={
                "code": "max_turns_exceeded",
                "message": f"agent exceeded {MAX_TOOL_TURNS} tool turns",
            },
        )
    except Exception as exc:
        log.exception("agent_loop_failed", request_id=rid, error=str(exc))
        yield AgentEvent(
            type="error",
            data={"code": "agent_error", "message": str(exc)},
        )
