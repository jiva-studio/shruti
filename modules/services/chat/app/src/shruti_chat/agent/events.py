"""Agent event — the smallest unit the loop produces.

`type` is the SSE event name the transport layer will emit. `data` is
the payload (already JSON-serialisable). Mobile parses these strings
verbatim — DO NOT rename without coordinating with the client AND
bumping the protocol version handshake in `api/chat.py`.

# SSE Protocol v1 — recognised event types

The client and server negotiate protocol version via the
`X-Chat-Protocol-Version` header (the request fails with 426 if
absent or unsupported). The current set is **9 event types**:

- `delta`      — text fragment            `{text: str}`
- `tool_start` — about to dispatch tool   `{name?: str}`
- `tool_end`   — dispatch completed       `{name?: str}`
- `status`     — i18n status label        `{key: str, params?: dict}`
                 ("searching_transcripts", "composing_answer", …)
- `action`     — client-side widget       `{kind, id, payload: {...}}`
                 — discriminated by `kind`. Auto-render kinds pair
                 with inline markers in delta text: `card`,
                 `outline`, `verse`, `cite_transcript` (carries the
                 transcript text for a `[cite:track@s-e|…]` fragment so
                 the client can render the full quote card; absent ⇒
                 the small citation chip). Interactive kinds get a
                 button + on-click mutation: `share_pdf`,
                 `enable_daily_reminder`, `configure_smart_library`,
                 `upgrade_to_pro`.
- `research_question` — sub-query the research pipeline is about
                 to investigate. Emitted live as `query_planner`
                 / `_regenerate_queries` returns. Payload:
                 `{question: str}`. Ephemeral — client renders
                 in the "what's being investigated" panel under
                 the streaming bubble; cleared the moment prose
                 deltas start landing.
- `research_source` — a source the pipeline is inspecting right
                 now (verse, lecture chunk, library doc). Emitted
                 BEFORE ranking/dedup so the user sees activity in
                 real-time, not after top-K is picked. Server does
                 NOT dedup — client dedups by `id`. Payload:
                 `{kind: "verse"|"lecture_chunk"|"library_doc",
                   id: str, label: str}`. Same ephemeral lifecycle
                 as `research_question`.
- `done`       — final terminator         `{aliases?: dict, tokens?: int}`
                 Aliases map embedded here (no separate event).
- `error`      — error payload            `{code, message, retry_after?}`
                 `code` is the contract: every client localises off it
                 and drops `message`. Build the frame with `error_event`
                 — `message` is a fixed fallback string, never the text
                 of the exception that caused the failure.

The two `research_*` events are additive — old clients ignore
unknown event names (chatClient drops them via the default branch),
so adding them did NOT bump the protocol version.

# What v1 collapsed (vs the unreleased prototype)

- `tool` event renamed to `tool_end` for symmetry with `tool_start`.
- `outline` event subsumed into `action.kind=outline`.
- `verse_payload` event subsumed into `action.kind=verse`.
- `aliases` event removed — map ships inline on `done.data.aliases`.

# Action event ordering invariant

Every `action` event MUST be emitted to the client BEFORE the
`delta` carrying its inline marker (`[^N]`, `[^N]`,
`[^N]`, `[action:kind|id=X]`). Worker nodes flush pending
action events on `on_tool_end` before the next LLM yield resumes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class AgentEvent:
    type: str
    data: dict[str, Any]


# Client-facing text for each `error` code. Every client localises the bubble
# off `code` alone and drops `message`, so this is the fallback for consumers
# that have no string for the code — it must never carry the exception text.
# A raw `str(exc)` here once shipped the internal model id, the provider name
# and a link to the provider's settings page to a user (issue #1568).
ERROR_MESSAGES: dict[str, str] = {
    "chat_unavailable": "The assistant is temporarily unavailable. Please try again shortly.",
    "agent_error": "The assistant could not complete this request.",
    "max_turns_exceeded": "The assistant took too many steps to answer this question.",
}

_ERROR_FALLBACK = "The assistant could not complete this request."


def error_event(code: str, message: str | None = None) -> AgentEvent:
    """Build the client-facing `error` frame for `code`.

    `message` is optional and only for codes that carry a genuinely
    caller-specific note; blank or omitted resolves to the fixed string for
    `code`, and an unknown code to a generic one — so the frame is never
    empty. Two of three production `chat_graph_failed` events carried an
    exception whose `str()` was empty and the client rendered nothing.
    """
    text = (message or "").strip() or ERROR_MESSAGES.get(code, _ERROR_FALLBACK)
    return AgentEvent(type="error", data={"code": code, "message": text})
