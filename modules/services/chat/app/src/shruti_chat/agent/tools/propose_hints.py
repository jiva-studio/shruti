"""Action-tools for inline feature hints during a normal user chat.

The autonomous scheduler creates standalone tutorial sessions for the
same three features (enable daily reminder, configure smart library,
upgrade to Pro). These tools give the LLM a way to suggest the SAME
features inline when the user's conversation naturally invites it —
e.g., they ask about scheduling, auto-download, or premium features
without specifically requesting the corresponding UI.

Contract (same shape as `track_pdf_generate`):
  1. Tool returns an `action_id`.
  2. Tool emits the SSE `action` event with the full payload.
  3. The LLM embeds `[action:<kind>|id=<action_id>]` inline.

Mobile-side, the chat store renders the matching ActionCard component
AND writes a `chat_messages_proactive_state` row so the autonomous
scheduler respects the 30-day cooldown across both channels.
"""

from __future__ import annotations

import re
from typing import Any

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.tools.actions import YieldEvent, _new_action_id, _noop_yield


# Bounded HH:mm — 00..23 hours, 00..59 minutes. The earlier loose
# pattern accepted nonsense like "25:99" / "99:99" that would survive
# the wire trip and crash `setHours(...)` on the device.
_TIME_RE = re.compile(r"^(?:[01]?\d|2[0-3]):[0-5]\d$")

# Per-list cap for `propose_configure_smart_library`. A hallucinating
# LLM could otherwise emit hundreds of ids that the mobile filter
# store would dutifully apply. Smart Library doesn't need more than
# this for any practical configuration.
MAX_FILTER_LEN = 50


async def propose_enable_reminder(
    time: str = "07:00",
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Suggest enabling the daily listening reminder."""
    t = (time or "07:00").strip()
    if not _TIME_RE.match(t):
        return {"error": "invalid_time"}
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "enable_daily_reminder",
            "id": action_id,
            "payload": {"time": t},
        },
    )
    return {"ok": True, "action_id": action_id}


async def propose_configure_smart_library(
    author_ids: list[str] | None = None,
    tag_ids: list[str] | None = None,
    source_ids: list[str] | None = None,
    location_ids: list[str] | None = None,
    language_codes: list[str] | None = None,
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Suggest configuring Smart Library (Pro auto-download).

    All filter args are optional; an empty payload still produces a
    valid card that opens the Smart Library settings sheet (or the
    paywall, if the user is not subscribed).
    """
    filters: dict[str, list[str]] = {}

    def _clean(xs: list[str] | None) -> list[str]:
        return [x for x in (xs or []) if isinstance(x, str) and x][:MAX_FILTER_LEN]

    if (vals := _clean(author_ids)):
        filters["author_ids"] = vals
    if (vals := _clean(tag_ids)):
        filters["tag_ids"] = vals
    if (vals := _clean(source_ids)):
        filters["source_ids"] = vals
    if (vals := _clean(location_ids)):
        filters["location_ids"] = vals
    if (vals := _clean(language_codes)):
        filters["language_codes"] = vals

    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "configure_smart_library",
            "id": action_id,
            "payload": {"filters": filters},
        },
    )
    return {"ok": True, "action_id": action_id}


async def propose_upgrade_to_pro(
    reason: str,
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Surface the paywall after explaining why Pro helps with the
    user's current task. `reason` is a short tag plumbed into paywall
    analytics — keep it short (1-3 words, snake_case)."""
    r = (reason or "").strip()
    if not r:
        return {"error": "reason_required"}
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "upgrade_to_pro",
            "id": action_id,
            "payload": {"reason": r[:64]},
        },
    )
    return {"ok": True, "action_id": action_id}


register_tool(ToolDef(
    name="reminder_propose",
    fn=propose_enable_reminder,
    emits_events=True,
    description=(
        "Suggest enabling the daily listening reminder — DOES NOT enable it. "
        "The client renders a confirmation card. After calling, embed "
        "`[action:enable_daily_reminder|id=<action_id>]` inline. Use only "
        "when the user is talking about staying consistent, daily practice, "
        "or asks 'how can I remember to listen daily / каждый день'. Do NOT "
        "suggest unsolicited."
    ),
    parameters={
        "type": "object",
        "properties": {
            "time": {
                "type": "string",
                "description": (
                    "Default 'HH:mm' for the reminder (24h, local). "
                    "Defaults to '07:00' — the user can change it later in Settings."
                ),
            },
        },
    },
))

register_tool(ToolDef(
    name="smart_library_propose",
    fn=propose_configure_smart_library,
    emits_events=True,
    description=(
        "Suggest configuring Smart Library (Pro auto-download) — DOES NOT configure it. "
        "The client renders a card; tapping it opens the Smart Library "
        "settings sheet for subscribed users, or the paywall otherwise. "
        "Embed `[action:configure_smart_library|id=<action_id>]` inline. "
        "Use when the user mentions wanting a constant queue of lectures, "
        "wants new lectures downloaded automatically, or asks about "
        "auto-download / Smart Library specifically. Pre-fill filter args "
        "(`tag_ids` / `author_ids` / etc.) only if the conversation already "
        "surfaced them — empty payload is fine and leads to a generic "
        "configuration."
    ),
    parameters={
        "type": "object",
        "properties": {
            "author_ids": {"type": "array", "items": {"type": "string"}},
            "tag_ids": {"type": "array", "items": {"type": "string"}},
            "source_ids": {"type": "array", "items": {"type": "string"}},
            "location_ids": {"type": "array", "items": {"type": "string"}},
            "language_codes": {"type": "array", "items": {"type": "string"}},
        },
    },
))

register_tool(ToolDef(
    name="pro_upgrade_propose",
    fn=propose_upgrade_to_pro,
    emits_events=True,
    description=(
        "Surface the Pro paywall when the user's question is gated by a "
        "Pro-only feature (Smart Library auto-download, Notes Studio, "
        "etc.). Embed `[action:upgrade_to_pro|id=<action_id>]` inline. "
        "`reason` is a short snake_case tag for paywall analytics: "
        "'smart_library', 'notes_studio', 'auto_archive', etc."
    ),
    parameters={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Short snake_case tag, e.g. 'smart_library'.",
            },
        },
        "required": ["reason"],
    },
))
