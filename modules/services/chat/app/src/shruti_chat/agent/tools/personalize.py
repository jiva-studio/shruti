"""Personalization tools — read from `user_context` injected via closure.

`user_context` is a frozen-dataclass `UserContext` instance (or None). It carries:
- recent_tracks: list of (track_id, last_played_at, percent, ...)
- current_track_id: what user is listening to right now (or just stopped)
- now: device wall-clock ISO with offset
- focus: optional pinned span (outline-chapter tap, citation re-ask)

These tools are exposed to the LLM with NO `user_context` parameter in
their JSON-Schema — the loop binds it via `build_personalized_tools`.

Notes are intentionally not in `user_context`: chat surfaces citations
as `[cite:...]` chips the user can save from the action sheet, but
there is no read/search direction in the current UX. When that
changes, add `recent_notes` back + the matching tool synchronously
with the consumer UI.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain import UserContext
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort
from shruti_chat.domain.user_context import TrackStatus, UserContextTrack


_NO_CTX_HINT = (
    "Контекст пользователя не передан. Скажи пользователю, что нужно "
    "сначала послушать или сохранить заметки, чтобы я мог опираться на историю."
)


def _ok_or_empty(items: list, has_ctx: bool) -> dict[str, Any] | list:
    if not has_ctx:
        return {"error": "user_context_missing", "hint": _NO_CTX_HINT}
    return items


def _chunk_to_wire(s, *, include_ref: bool) -> dict[str, Any]:
    row: dict[str, Any] = {
        "track_id": s.chunk.track_id,
        "lang": s.chunk.lang,
        "start_ms": s.chunk.start_ms,
        "end_ms": s.chunk.end_ms,
        "text": s.chunk.text,
        "score": s.score,
    }
    if include_ref:
        row["reference_source_id"] = s.chunk.reference_source_id
    return row


def _track_to_wire(t: UserContextTrack) -> dict[str, Any]:
    return {
        "track_id": t.track_id,
        "position_ms": t.position_ms,
        "percent": t.percent,
        "last_played_at": (
            t.last_played_at.isoformat() if t.last_played_at else None
        ),
    }


def _parse_iso(value: str | None, *, field: str) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be ISO-8601 (got {value!r})") from exc


async def list_my_tracks(
    *,
    user_context: UserContext | None = None,
    since: str | None = None,
    until: str | None = None,
    status: TrackStatus = "any",
    limit: int = 20,
    catalog_repo: CatalogRepository,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Recently-played tracks from the user's history, optionally
    filtered by time window and completion status. Returns wire rows
    `{track_id, position_ms, percent, last_played_at}` for cards.

    Stale `track_id`s — present in user history but missing from the
    current catalog (post-import drift, renames) — are dropped before
    returning so the LLM doesn't emit `[card:X]` markers the client
    can't resolve.
    """
    if user_context is None:
        return _ok_or_empty([], False)

    try:
        since_dt = _parse_iso(since, field="since")
        until_dt = _parse_iso(until, field="until")
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
    return [_track_to_wire(t) for t in capped if t.track_id in live]


async def search_my_history(
    query: str,
    *,
    user_context: UserContext | None = None,
    lang: str | None = None,
    top_k: int = 8,
    chunk_repo: ChunkRepository,
    embedder: EmbedderPort,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Semantic search restricted to recent_tracks."""
    if user_context is None:
        return _ok_or_empty([], False)
    ids = [t.track_id for t in user_context.recent_tracks]
    if not ids:
        return []
    q_vec = await embedder.embed_query(query)
    k = max(1, min(top_k, 16))

    async def _run(use_lang: str | None) -> list[dict[str, Any]]:
        scored = await chunk_repo.search_by_embedding(
            q_vec,
            eligible_track_ids=ids,
            lang=use_lang,
            top_k=k,
        )
        return [_chunk_to_wire(s, include_ref=True) for s in scored]

    rows = await _run(lang)
    if not rows and lang is not None:
        rows = await _run(None)
    return rows


async def recommend_next(
    *,
    user_context: UserContext | None = None,
    lang: str | None = None,
    top_k: int = 6,
    chunk_repo: ChunkRepository,
) -> dict[str, Any] | list[dict[str, Any]]:
    """ANN from a centroid of the user's recent listening.

    Pure user-history call: takes the centroid of the first chunk of
    each of the last 5 `recent_tracks` and ANN-searches the rest of the
    corpus, excluding those seed tracks.

    For "recommend something like THIS lecture" (no user context, or a
    specific anchor), use `find_similar_chunks(track_id=...)` instead.
    """
    if user_context is None:
        return _ok_or_empty([], False)
    seed_ids = [t.track_id for t in user_context.recent_tracks[:5]]
    if not seed_ids:
        return []
    k = max(1, min(top_k, 12))

    async def _run(use_lang: str | None) -> list[dict[str, Any]]:
        seed_vecs = await chunk_repo.get_first_chunk_embeddings(seed_ids, lang=use_lang)
        if not seed_vecs:
            return []
        dim = len(seed_vecs[0])
        centroid = [sum(v[i] for v in seed_vecs) / len(seed_vecs) for i in range(dim)]
        scored = await chunk_repo.search_by_embedding(
            centroid,
            excluded_track_ids=seed_ids,
            lang=use_lang,
            top_k=k,
        )
        return [_chunk_to_wire(s, include_ref=False) for s in scored]

    rows = await _run(lang)
    if not rows and lang is not None:
        rows = await _run(None)
    return rows


register_tool(ToolDef(
    name="list_my_tracks",
    fn=list_my_tracks,
    personalized=True,
    description=(
        "List tracks from the user's listening history, optionally "
        "filtered by `last_played_at` window and completion status. "
        "Returns track rows for `[card:track_id]` markers.\n\n"
        "Use whenever the user asks about HISTORY (what / when / how "
        "long ago they listened):\n"
        "  • «что я слушал на этой неделе» → "
        "    `list_my_tracks(since=<start-of-week>, until=<now>)`\n"
        "  • «продолжить / где я остановился» → "
        "    `list_my_tracks(status='in_progress', limit=3)`\n"
        "  • «что я дослушал в прошлом месяце» → "
        "    `list_my_tracks(status='completed', since=…, until=…)`\n\n"
        "Compute `since` / `until` from `user_context.now` yourself "
        "(it's in the system prompt). Pass ISO-8601 strings with the "
        "same offset as `now`. Do NOT call `list_tracks` for history — "
        "that tool filters by LECTURE date, not listen date."
    ),
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
                    "Inclusive upper bound on `last_played_at`, ISO-8601 "
                    "with offset."
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

register_tool(ToolDef(
    name="recommend_next",
    fn=recommend_next,
    personalized=True,
    description=(
        "Recommend tracks similar to what the user recently listened to "
        "(centroid of last 5 recent_tracks). Requires user_context with "
        "non-empty recent listening. For 'recommend something like THIS "
        "lecture' (no user history needed) use `find_similar_chunks` "
        "with just `track_id`."
    ),
    parameters={
        "type": "object",
        "properties": {
            "lang": {"type": "string", "enum": ["ru", "en"]},
            "top_k": {"type": "integer", "default": 6},
        },
    },
))

register_tool(ToolDef(
    name="search_my_history",
    fn=search_my_history,
    personalized=True,
    description=(
        "Semantic search restricted to the user's recent_tracks. Use for "
        "'I heard something about X recently, find it'."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "lang": {"type": "string", "enum": ["ru", "en"]},
            "top_k": {"type": "integer", "default": 8},
        },
        "required": ["query"],
    },
))
