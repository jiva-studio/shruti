"""Action-tools — propose a client-side action.

These don't execute anything server-side. They:
1. Validate the proposal (track_ids exist, name non-empty, ...).
2. Call the loop-supplied `yield_event` callable to emit the SSE
   `action` side-event with the full payload (kind, id, name, tracks…).
3. Return a small dict containing the `marker` string the LLM should
   embed inline in its reply (e.g. `[action:create_playlist|id=abc12345]`).

The client picks up the SSE event, stores the payload by `id`, finds the
inline marker in the rendered text, and mounts the corresponding card.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Callable

from lectorium_chat.agent.tools._sqlite import catalog_conn


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


def _validate_track_ids_sync(track_ids: list[str]) -> list[str]:
    if not track_ids:
        return []
    placeholders = ",".join("?" * len(track_ids))
    with catalog_conn() as conn:
        rows = conn.execute(
            f"SELECT id FROM tracks WHERE hidden = 0 AND id IN ({placeholders})",
            list(track_ids),
        ).fetchall()
    return [r["id"] for r in rows]


MAX_PLAYLIST_TRACKS = 30


async def propose_playlist(
    name: str,
    track_ids: list[str],
    rationale: str | None = None,
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Ask the client to create a playlist (after user confirmation)."""
    name = (name or "").strip()
    if not name:
        return {"error": "name_required"}
    # Cap before catalog lookup — keeps the SQL IN-list small AND keeps the
    # confirmation card sane on small screens. The LLM is told ≤20 in the
    # prompt; 30 is the hard ceiling.
    requested = list(track_ids or [])[:MAX_PLAYLIST_TRACKS]
    valid = await asyncio.to_thread(_validate_track_ids_sync, requested)
    if not valid:
        return {"error": "no_valid_tracks"}
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "create_playlist",
            "id": action_id,
            "name": name,
            "track_ids": valid,
            "rationale": rationale or "",
        },
    )
    return {
        "ok": True,
        "action_id": action_id,
        "marker": f"[action:create_playlist|id={action_id}]",
        "validated_track_ids": valid,
    }


async def propose_save_note(
    track_id: str,
    start_ms: int,
    end_ms: int,
    text: str,
    suggested_caption: str | None = None,
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Ask the client to save a note (after user confirmation)."""
    text = (text or "").strip()
    if not text:
        return {"error": "text_required"}
    if not track_id:
        return {"error": "track_id_required"}
    if end_ms < start_ms:
        end_ms = start_ms
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "save_note",
            "id": action_id,
            "track_id": track_id,
            "start_ms": int(start_ms),
            "end_ms": int(end_ms),
            "text": text,
            "suggested_caption": (suggested_caption or "").strip(),
        },
    )
    return {
        "ok": True,
        "action_id": action_id,
        "marker": f"[action:save_note|id={action_id}]",
    }


TOOL_REGISTRY = [
    {
        "name": "propose_playlist",
        "fn": propose_playlist,
        "personalized": False,
        "emits_events": True,
        "description": (
            "Propose creating a playlist for the user — DOES NOT create it. "
            "The client will render a card with a confirm button. After "
            "calling, embed the returned marker (e.g. '[action:create_playlist|id=...]') "
            "inline in your reply at the position the card should render. "
            "Never claim the playlist exists — say 'предлагаю собрать плейлист'. "
            "Pick at most 20 track_ids (server hard-caps at 30). "
            "DO NOT also emit `[card:...]` for the same tracks — the action card shows them itself."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short playlist name (3-6 words)"},
                "track_ids": {"type": "array", "items": {"type": "string"}},
                "rationale": {"type": "string"},
            },
            "required": ["name", "track_ids"],
        },
    },
    {
        "name": "propose_save_note",
        "fn": propose_save_note,
        "personalized": False,
        "emits_events": True,
        "description": (
            "Propose saving a quote as a user note — DOES NOT save it. "
            "The client will render a card with a confirm button. Embed "
            "the returned marker inline. Never claim the note is saved."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "track_id": {"type": "string"},
                "start_ms": {"type": "integer"},
                "end_ms": {"type": "integer"},
                "text": {"type": "string"},
                "suggested_caption": {"type": "string"},
            },
            "required": ["track_id", "start_ms", "end_ms", "text"],
        },
    },
]
