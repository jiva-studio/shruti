"""Action-tools — propose a client-side action.

These don't execute anything server-side. They:
1. Validate the proposal.
2. Call the loop-supplied `yield_event` callable to emit the SSE
   `action` side-event with the full payload (kind, id, …).
3. Return a small dict containing the `marker` string the LLM should
   embed inline in its reply (e.g. `[action:share_pdf|id=abc12345]`).

The client picks up the SSE event, stores the payload by `id`, finds the
inline marker in the rendered text, and mounts the corresponding card.

Note: playlist creation has NO action-tool. "Playlist requests" route
through find_track → catalog_worker → list of `[^N]` track-card
markers; the client renders the stack and offers an in-app
"add to playlist" button when there are ≥2 cards. No server-side
proposal step.
"""

from __future__ import annotations

import secrets
from typing import Any, Callable

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when a tool is invoked outside the agent loop (e.g. tests)."""


def _new_action_id() -> str:
    """8-char hex token, used as the inline marker id (`[action:...|id=...]`).

    Hex (no -, _, /, +) keeps it safe in URL fragments and marker grammar
    without any post-processing. 8 chars = 32 bits of entropy — collision
    probability across a session is negligible (we emit ≤ a few cards per
    turn).
    """
    return secrets.token_hex(4)
