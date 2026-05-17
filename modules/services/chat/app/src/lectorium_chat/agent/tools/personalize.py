"""Personalization tools — read from `user_context` injected via closure.

`user_context` is a pydantic `UserContext` instance (or None). It carries:
- recent_tracks: list of (track_id, last_played_at, percent, ...)
- current_track_id: what user is listening to right now (or just stopped)
- now: device wall-clock ISO with offset
- focus: optional pinned span (outline-chapter tap, citation re-ask)

These tools are exposed to the LLM with NO `user_context` parameter in
their JSON-Schema — the loop binds it via `build_personalized_tools`.

Notes are intentionally not in `user_context`: chat only writes notes
via the `propose_save_note` action; there is no read/search direction
in the current UX. When that changes, add `recent_notes` back + the
matching tool synchronously with the consumer UI.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.domain import UserContext
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort


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


async def continue_listening(
    *, user_context: UserContext | None = None,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Top-3 unfinished tracks from `recent_tracks`, recency-ordered.

    "Unfinished" = past the «accidentally tapped» threshold but not near
    the end: 5% < percent < 95%. The policy lives here so the wire
    format stays slim — clients send the full recent_tracks list and
    the server derives the in-progress slice on demand.
    """
    if user_context is None:
        return _ok_or_empty([], False)
    filtered = [
        t for t in user_context.recent_tracks
        if t.percent is not None and 0.05 < t.percent < 0.95
    ]
    filtered.sort(key=lambda t: t.last_played_at or "", reverse=True)
    return [
        {
            "track_id": t.track_id,
            "position_ms": t.position_ms,
            "percent": t.percent,
            "last_played_at": t.last_played_at,
        }
        for t in filtered[:3]
    ]


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


TOOL_REGISTRY = [
    {
        "name": "continue_listening",
        "fn": continue_listening,
        "personalized": True,
        "description": (
            "Return the user's in-progress tracks (top 3, recency-ordered). "
            "Use when user asks 'where did I stop', 'continue listening'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "recommend_next",
        "fn": recommend_next,
        "personalized": True,
        "description": (
            "Recommend tracks similar to what the user recently listened to "
            "(centroid of last 5 recent_tracks). Requires user_context with "
            "non-empty recent listening. For 'recommend something like THIS "
            "lecture' (no user history needed) use `find_similar_chunks` "
            "with just `track_id`."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "lang": {"type": "string", "enum": ["ru", "en"]},
                "top_k": {"type": "integer", "default": 6},
            },
        },
    },
    {
        "name": "search_my_history",
        "fn": search_my_history,
        "personalized": True,
        "description": (
            "Semantic search restricted to the user's recent_tracks. Use for "
            "'I heard something about X recently, find it'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "lang": {"type": "string", "enum": ["ru", "en"]},
                "top_k": {"type": "integer", "default": 8},
            },
            "required": ["query"],
        },
    },
]
