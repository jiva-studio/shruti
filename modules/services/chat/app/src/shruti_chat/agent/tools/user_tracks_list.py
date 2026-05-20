"""user_tracks_list — list tracks from the user's listening history."""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._helpers import ok_or_no_ctx, parse_iso
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain import UserContext
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.user_context import TrackStatus, UserContextTrack


_DESCRIPTION = (
    "List tracks from the user's listening history, optionally filtered "
    "by `last_played_at` window and completion status. Returns track "
    "rows with an integer `track_ref` (use it as `[card:N]` for cards "
    "and as `track_ref=` in chunks_get_window / chunks_find_similar).\n\n"
    "Use whenever the user asks about HISTORY (what / when / how long "
    "ago they listened):\n"
    "  • «что я слушал на этой неделе» → "
    "    `user_tracks_list(since=<start-of-week>, until=<now>)`\n"
    "  • «продолжить / где я остановился» → "
    "    `user_tracks_list(status='in_progress', limit=3)`\n"
    "  • «что я дослушал в прошлом месяце» → "
    "    `user_tracks_list(status='completed', since=…, until=…)`\n\n"
    "Compute `since` / `until` from `user_context.now` yourself (it's "
    "in the system prompt). Pass ISO-8601 strings with the same offset "
    "as `now`. Do NOT call `list_tracks` for history — that tool filters "
    "by LECTURE date, not listen date."
)


def _track_to_wire(t: UserContextTrack, *, alias_map: TurnAliasMap) -> dict[str, Any]:
    return {
        "track_ref": alias_map.alias_track(t.track_id),
        "position_ms": t.position_ms,
        "percent": t.percent,
        "last_played_at": (
            t.last_played_at.isoformat() if t.last_played_at else None
        ),
    }


async def user_tracks_list(
    *,
    user_context: UserContext | None = None,
    since: str | None = None,
    until: str | None = None,
    status: TrackStatus = "any",
    limit: int = 20,
    catalog_repo: CatalogRepository,
    alias_map: TurnAliasMap,
) -> dict[str, Any] | list[dict[str, Any]]:
    if user_context is None:
        return ok_or_no_ctx([], False)
    try:
        since_dt = parse_iso(since, field="since")
        until_dt = parse_iso(until, field="until")
    except ValueError as exc:
        return {"error": "bad_argument", "hint": str(exc)}
    rows = user_context.tracks_in_window(
        since=since_dt, until=until_dt, status=status,
    )
    if not rows:
        return []
    capped = rows[: max(1, min(limit, 50))]
    track_ids = [t.track_id for t in capped]
    live = set(await catalog_repo.filter_existing_track_ids(track_ids))
    return [
        _track_to_wire(t, alias_map=alias_map) for t in capped if t.track_id in live
    ]


register_tool(ToolDef(
    name="user_tracks_list",
    fn=user_tracks_list,
    personalized=True,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "since": {
                "type": "string",
                "description": (
                    "Inclusive lower bound on `last_played_at`, ISO-8601 "
                    "with offset (e.g. '2026-05-12T00:00:00+03:00')."
                ),
            },
            "until": {
                "type": "string",
                "description": (
                    "Inclusive upper bound on `last_played_at`, ISO-8601 with offset."
                ),
            },
            "status": {
                "type": "string",
                "enum": ["any", "in_progress", "completed"],
                "default": "any",
                "description": (
                    "Completion filter. `in_progress`: 5%-95% listened. "
                    "`completed`: >=95% listened. `any`: no filter."
                ),
            },
            "limit": {"type": "integer", "default": 20},
        },
    },
))
