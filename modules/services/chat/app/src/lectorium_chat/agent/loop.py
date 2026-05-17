"""Agent loop — function-calling with token-level streaming.

Every LLM call is streamed: text deltas are yielded immediately so the
client gets a typing-effect render, while tool_call fragments are buffered
and dispatched only once the stream completes. Up to MAX_TOOL_TURNS rounds.

AgentEvent types:
    - 'delta'   : text fragment of assistant response
    - 'tool'    : tool call dispatched ({name, duration_ms, result_count})
    - 'action'  : client-side action proposed by a tool ({kind, id, ...payload})
    - 'outline' : track outline payload ({track_id, items: [...]})
    - 'done'    : final summary
    - 'error'   : error payload
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable

from lectorium_chat.agent import llm
from lectorium_chat.agent.prompts import SYSTEM_PROMPT
from lectorium_chat.agent.tools import TOOL_SCHEMAS, TOOLS, build_personalized_tools
from lectorium_chat.config import get_settings
from lectorium_chat.domain import UserContext
from lectorium_chat.observability.logging import get_logger

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


def _make_messages(
    history: list[dict[str, Any]],
    lang: str,
    user_context: UserContext | None = None,
) -> list[dict[str, Any]]:
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
    ctx_directive = _format_user_context(user_context)
    sys = {"role": "system", "content": SYSTEM_PROMPT + lang_directive + ctx_directive}
    # Strip any non-standard fields from history (defensive)
    clean = [{"role": m["role"], "content": m["content"]} for m in history
             if m.get("role") in ("user", "assistant") and m.get("content")]
    return [sys, *clean]


def _format_user_context(uc: UserContext | None) -> str:
    """Render the small temporal anchors into the system prompt.

    Big lists (recent_tracks/notes) stay accessible only via personalize
    tools — pasting them into the prompt would explode the token bill on
    every turn. But `now` and `current_track_id` are tiny and load-bearing
    for relative-time and "this lecture" phrases — those go inline.
    """
    if uc is None:
        return ""
    lines: list[str] = []
    if uc.now:
        lines.append(f"now: {uc.now}")
    if uc.tz_offset_minutes is not None:
        lines.append(f"tz_offset_minutes: {uc.tz_offset_minutes}")
    if uc.current_track_id:
        lines.append(f"current_track_id: {uc.current_track_id}")
    if uc.focus is not None:
        ftitle = uc.focus.title or ""
        lines.append(
            f"focus: track_id={uc.focus.track_id} "
            f"start_ms={uc.focus.start_ms} "
            f"end_ms={uc.focus.end_ms} "
            f"title={ftitle!r}"
        )
    lines.append(
        f"history_size: recent={len(uc.recent_tracks)} "
        f"in_progress={len(uc.in_progress)} notes={len(uc.recent_notes)}"
    )
    if not lines:
        return ""
    return (
        "\n\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        "USER CONTEXT (anchors for relative-time and 'this lecture' phrases)\n"
        "═══════════════════════════════════════════════════════════════════════\n\n"
        + "\n".join(lines)
        + "\n\n"
        "Use `now` to resolve «вчера / на этой неделе / a week ago» queries\n"
        "against `last_played_at` returned by personalize tools.\n\n"
        "When the user says «эту / текущую / только что слушал / this / current»\n"
        "lecture OR doesn't name any lecture — and `current_track_id` is set —\n"
        "use it directly as the track_id for `get_track_outline` /\n"
        "`get_transcript_window` etc. NEVER outline a random track when the\n"
        "user means 'this one' — that's the worst kind of hallucination here.\n"
        "If `current_track_id` is NOT set and the user didn't name a track,\n"
        "ask which lecture they mean instead of guessing.\n\n"
        "If `focus` is set, the user has tapped a specific span (an outline\n"
        "chapter or a citation) and the request implicitly targets it.\n"
        "Always start with `get_transcript_window(track_id=focus.track_id,\n"
        "around_ms=(focus.start_ms + focus.end_ms)/2,\n"
        "window_seconds=ceil((focus.end_ms - focus.start_ms) / 1000) + 30)`\n"
        "and base your retelling on those chunks. Cite individual lines\n"
        "with [cite:track_id@start_ms-end_ms|caption]. Do NOT call\n"
        "get_track_outline — the user already saw it.\n"
    )


async def run_agent(
    history: list[dict[str, Any]],
    lang: str = "ru",
    request_id: str | None = None,
    user_context: UserContext | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run the agent and yield AgentEvents.

    `user_context` is injected into personalize tools via per-request
    wrappers (see `build_personalized_tools`).
    """
    settings = get_settings()
    rid = request_id or uuid.uuid4().hex[:8]
    messages = _make_messages(history, lang, user_context)
    tools = build_personalized_tools(TOOLS, user_context)

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
                fn = tools.get(name)
                side_events: list[AgentEvent] = []
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
                        # Tools may emit side events (action/outline) by
                        # returning a dict with `_side_events: [{type, data}]`.
                        # We strip the key from the LLM-visible result and
                        # yield each event before the canonical `tool` event.
                        if isinstance(result, dict) and "_side_events" in result:
                            raw = result.pop("_side_events") or []
                            for se in raw:
                                if isinstance(se, dict) and "type" in se and "data" in se:
                                    side_events.append(AgentEvent(
                                        type=se["type"], data=se["data"]))
                        result_count = len(result) if isinstance(result, list) else 1
                    duration_ms = int((time.monotonic() - t1) * 1000)
                    log.info(
                        "tool_call",
                        request_id=rid,
                        tool_name=name,
                        args=args,
                        duration_ms=duration_ms,
                        result_count=result_count,
                        side_events=len(side_events),
                    )

                for se in side_events:
                    yield se
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
