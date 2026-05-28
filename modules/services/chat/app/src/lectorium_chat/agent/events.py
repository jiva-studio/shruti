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
                 `outline`, `verse`. Interactive kinds get a button +
                 on-click mutation: `share_pdf`,
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
