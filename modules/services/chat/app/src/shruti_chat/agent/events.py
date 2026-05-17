"""Agent event — the smallest unit the loop produces.

`type` is the SSE event name the transport layer will emit. `data` is
the payload (already JSON-serialisable). Mobile parses these strings
verbatim — DO NOT rename without coordinating with the client.

Recognised types and their payloads:
- `delta`      — text fragment        `{text: str}`
- `tool_start` — about to dispatch    `{}`
- `tool`       — dispatch completed   `{}`
- `action`     — client-side action   `{kind, id, ...}`
- `outline`    — outline payload      `{track_id, items: [...]}`
- `done`       — final terminator     `{}`
- `error`      — error payload        `{code, message, retry_after?}`
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class AgentEvent:
    type: str
    data: dict[str, Any]
