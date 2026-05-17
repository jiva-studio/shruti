"""Agent loop — function-calling with token-level streaming.

Every LLM call is streamed: text deltas are yielded immediately so the
client gets a typing-effect render, while tool_call fragments are buffered
and dispatched only once the stream completes. Up to MAX_TOOL_TURNS rounds.

AgentEvent types (data shapes shown — `{}` means empty payload, the
event type itself is the whole signal):
    - 'delta'      : text fragment ({text})
    - 'tool_start' : about to dispatch a tool ({}). Client drops any
                     preamble text streamed so far.
    - 'tool'       : tool call completed ({}). Bookend marker only —
                     metrics live in structured logs.
    - 'action'     : client-side action proposed by a tool ({kind, id, ...})
    - 'outline'    : track outline payload ({track_id, items: [...]})
    - 'done'       : final terminator ({}). Per-request stats are in
                     structured logs (`chat_done` log line).
    - 'error'      : error payload ({code, message, retry_after?})
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable

from shruti_chat.agent import llm
from shruti_chat.agent.prompts import SYSTEM_PROMPT
from shruti_chat.agent.tools import (
    EMITS_EVENTS,
    TOOL_SCHEMAS,
    TOOLS,
    build_personalized_tools,
)
from shruti_chat.config import get_settings
from shruti_chat.domain import UserContext
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

# Ceiling on tool-call turns per /chat request. Real-world playlist /
# multi-criteria queries observably need 5-7 turns (resolve_source →
# search_transcripts → list_tracks → resolve_tag → list_tracks → answer).
# 10 leaves comfortable headroom for the agent's exploratory passes
# without inviting runaway loops. Hitting the ceiling surfaces a typed
# error to the client so the UX can render a specific "agent didn't
# converge" message instead of a generic network failure.
MAX_TOOL_TURNS = 10


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
        # `now` carries its own UTC offset (e.g. "+03:00"); no separate
        # tz field needed — parse the offset out of this string if you
        # ever want it as minutes.
        lines.append(f"now: {uc.now}")
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
    # In-progress count is derived from recent_tracks (5%<percent<95%);
    # see continue_listening for the canonical filter. Surface a count
    # here only so the LLM knows whether the personalize tools have
    # anything to return.
    in_progress_n = sum(
        1
        for t in uc.recent_tracks
        if t.percent is not None and 0.05 < t.percent < 0.95
    )
    lines.append(
        f"history_size: recent={len(uc.recent_tracks)} "
        f"in_progress={in_progress_n}"
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
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run the agent and yield AgentEvents.

    `user_context` is injected into personalize tools via per-request
    wrappers (see `build_personalized_tools`).

    `is_disconnected`, when supplied, is awaited between LLM turns and on
    every streamed chunk to detect a client that closed the connection
    mid-response. The loop then raises CancelledError so any in-flight
    LLM stream tears down — saves both Gemini cost and the user-side
    "still spinning" UI on partial network drops.
    """
    settings = get_settings()
    rid = request_id or uuid.uuid4().hex[:8]
    messages = _make_messages(history, lang, user_context)
    tools = build_personalized_tools(TOOLS, user_context)

    total_input_tokens = 0
    total_output_tokens = 0
    tool_calls_made = 0
    started = time.monotonic()

    async def _client_gone() -> bool:
        return bool(is_disconnected and await is_disconnected())

    try:
        for turn in range(MAX_TOOL_TURNS):
            if await _client_gone():
                log.info("agent_cancelled_pre_turn", request_id=rid, turn=turn)
                return
            t0 = time.monotonic()
            content_buf: list[str] = []
            tool_calls_by_index: dict[int, dict[str, Any]] = {}
            usage = None

            async for chunk in llm.stream_completion(
                model=settings.llm_default,
                messages=messages,
                tools=TOOL_SCHEMAS,
            ):
                if await _client_gone():
                    log.info("agent_cancelled_mid_stream", request_id=rid, turn=turn)
                    return
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
                # Metrics (tokens, duration, tool count) live in structured
                # logs (`log.info("llm_call", ...)`) — SSE is for UX events,
                # not telemetry.
                log.info(
                    "chat_done",
                    request_id=rid,
                    total_tokens=total_input_tokens + total_output_tokens,
                    tool_calls=tool_calls_made,
                    duration_ms=int((time.monotonic() - started) * 1000),
                )
                yield AgentEvent(type="done", data={})
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
                # Signal the client to drop any preamble text the LLM
                # streamed during this turn before it decided to call a
                # tool ("Я сделаю это через search_transcripts…"). The
                # post-tool `tool` event used to do this implicitly; now
                # the responsibility is explicit and lives BEFORE the
                # dispatch so the UI clears immediately, not after the
                # tool finishes (which can take seconds).
                # tool_start is a clear-preamble signal — the event type
                # is the entire message; name is in structured logs.
                yield AgentEvent(type="tool_start", data={})
                fn = tools.get(name)
                # Per-call buffer for side-events the tool may emit via the
                # injected `yield_event` callable. Drained after the tool
                # returns; yielded BEFORE the canonical `tool` event so the
                # client can mount the action/outline card by the time the
                # tool-completion bookkeeping arrives.
                side_events: list[AgentEvent] = []

                def yield_event(
                    ev_type: str, data: dict[str, Any],
                    _buf: list[AgentEvent] = side_events,
                ) -> None:
                    _buf.append(AgentEvent(type=ev_type, data=data))

                if fn is None:
                    result: Any = {"error": f"unknown tool {name!r}"}
                    result_count = 0
                    duration_ms = 0
                else:
                    t1 = time.monotonic()
                    call_kwargs = dict(args)
                    if name in EMITS_EVENTS:
                        call_kwargs["yield_event"] = yield_event
                    try:
                        result = await fn(**call_kwargs)
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
                        side_events=len(side_events),
                    )

                for se in side_events:
                    yield se
                # `tool` event is the closing bookend (between tool_start
                # and the next delta). Metrics — name, duration_ms,
                # result_count — live in `log.info("tool_call", ...)`
                # above. Client uses the event-type only.
                yield AgentEvent(type="tool", data={})
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
