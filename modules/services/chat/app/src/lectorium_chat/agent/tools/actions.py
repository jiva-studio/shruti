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

import secrets
from typing import Any, Callable

from lectorium_chat.agent.tools._registry import ToolDef, register_tool
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository
from lectorium_chat.observability.logging import get_logger


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


MAX_PLAYLIST_TRACKS = 30


async def propose_playlist(
    name: str,
    track_ids: list[str],
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Ask the client to create a playlist (after user confirmation).

    Validates every requested track_id against the catalog. If any are
    rejected, the LLM sees both the validated subset AND the dropped
    ids in the tool result so it can rephrase its surrounding prose
    (e.g. "I made a playlist of 10 lectures" while we only kept 6
    would silently lie — instead the model gets a chance to correct).

    If ALL ids are invalid, the SSE `action` event is suppressed
    entirely and the LLM gets an error so it has to retry or back out.
    """
    name = (name or "").strip()
    if not name:
        return {"error": "name_required"}
    # Cap before catalog lookup — keeps the SQL IN-list small AND keeps the
    # confirmation card sane on small screens. The LLM is told ≤20 in the
    # prompt; 30 is the hard ceiling.
    requested = list(track_ids or [])[:MAX_PLAYLIST_TRACKS]
    valid = await catalog_repo.filter_existing_track_ids(requested)
    rejected = [t for t in requested if t not in set(valid)]
    if rejected:
        log.info(
            "chat_tool_call_partial_rejected",
            tool="playlist_propose",
            rejected_count=len(rejected),
            rejected_track_ids=rejected,
        )
    if not valid:
        return {
            "error": "all_track_ids_invalid",
            "rejected_track_ids": rejected,
            "hint": (
                "Every track_id you supplied is missing from the catalog. "
                "Re-run chunks_search / tracks_list for fresh ids — "
                "do not invent or reuse ids from past chats."
            ),
        }
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "create_playlist",
            "id": action_id,
            "payload": {
                "name": name,
                "track_ids": valid,
            },
        },
    )
    return {
        "ok": True,
        "action_id": action_id,
        "validated_track_ids": valid,
        "rejected_track_ids": rejected,
    }


register_tool(ToolDef(
    name="playlist_propose",
    fn=propose_playlist,
    emits_events=True,
    description=(
        "Propose creating a playlist for the user — DOES NOT create it. "
        "The client will render a card with a confirm button. After "
        "calling, embed the marker `[action:create_playlist|id=<action_id>]` "
        "inline in your reply where the card should render (construct it "
        "from the returned `action_id`). Never claim the playlist exists — "
        "say 'предлагаю собрать плейлист'. Pick at most 20 track_ids "
        "(server hard-caps at 30). DO NOT also call `propose_card` for the "
        "same tracks — the action card shows them itself. "
        "Returns `{ok, action_id, validated_track_ids, rejected_track_ids}` "
        "— if `rejected_track_ids` is non-empty, the catalog could not "
        "find those ids and you should adjust your prose accordingly (do "
        "NOT claim a count of lectures that includes the rejected ones). "
        "If every id is rejected the tool returns "
        "`{error: 'all_track_ids_invalid'}` and emits no action event — "
        "re-search for fresh ids or back out of the proposal."
    ),
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short playlist name (3-6 words)"},
            "track_ids": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["name", "track_ids"],
    },
))

