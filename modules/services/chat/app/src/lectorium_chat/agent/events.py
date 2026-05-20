"""Agent event — the smallest unit the loop produces.

`type` is the SSE event name the transport layer will emit. `data` is
the payload (already JSON-serialisable). Mobile parses these strings
verbatim — DO NOT rename without coordinating with the client AND
bumping the protocol version handshake in `api/chat.py`.

# SSE Protocol v1 — recognised event types

The client and server negotiate protocol version via the
`X-Chat-Protocol-Version` header (the request fails with 426 if
absent or unsupported). The current set is **7 event types**:

- `delta`      — text fragment            `{text: str}`
- `tool_start` — about to dispatch tool   `{name?: str}`
- `tool_end`   — dispatch completed       `{name?: str}`
- `status`     — i18n status label        `{key: str, params?: dict}`
                 ("searching_transcripts", "composing_answer", …)
- `action`     — client-side widget       `{kind, id, payload: {...}}`
                 — discriminated by `kind`. Auto-render kinds pair
                 with inline markers in delta text: `card`,
                 `outline`, `verse`. Interactive kinds get a button +
                 on-click mutation: `create_playlist`, `share_pdf`,
                 `enable_daily_reminder`, `configure_smart_library`,
                 `upgrade_to_pro`.
- `done`       — final terminator         `{aliases?: dict, tokens?: int}`
                 Aliases map embedded here (no separate event).
- `error`      — error payload            `{code, message, retry_after?}`

# What v1 collapsed (vs the unreleased prototype)

- `tool` event renamed to `tool_end` for symmetry with `tool_start`.
- `outline` event subsumed into `action.kind=outline`.
- `verse_payload` event subsumed into `action.kind=verse`.
- `aliases` event removed — map ships inline on `done.data.aliases`.

# Action event ordering invariant

Every `action` event MUST be emitted to the client BEFORE the
`delta` carrying its inline marker (`[card:N]`, `[outline:N]`,
`[verse:N]`, `[action:kind|id=X]`). Worker nodes flush pending
action events on `on_tool_end` before the next LLM yield resumes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class AgentEvent:
    type: str
    data: dict[str, Any]
