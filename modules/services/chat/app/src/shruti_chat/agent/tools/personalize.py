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

from shruti_chat.db.client import get_pool
from shruti_chat.domain import UserContext
from shruti_chat.indexer.embed import get_embedder


_NO_CTX_HINT = (
    "Контекст пользователя не передан. Скажи пользователю, что нужно "
    "сначала послушать или сохранить заметки, чтобы я мог опираться на историю."
)


def _ok_or_empty(items: list, has_ctx: bool) -> dict[str, Any] | list:
    if not has_ctx:
        return {"error": "user_context_missing", "hint": _NO_CTX_HINT}
    return items


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
) -> dict[str, Any] | list[dict[str, Any]]:
    """Semantic search restricted to recent_tracks."""
    if user_context is None:
        return _ok_or_empty([], False)
    ids = [t.track_id for t in user_context.recent_tracks]
    if not ids:
        return []
    embedder = get_embedder()
    q_vec = await embedder.embed_query(query)
    where = ["embed_model = $1", "track_id = ANY($2::text[])"]
    params: list[Any] = [embedder.name, ids]
    if lang:
        where.append(f"lang = ${len(params) + 1}")
        params.append(lang)
    params.append(q_vec)
    params.append(max(1, min(top_k, 16)))
    sql = f"""
      SELECT track_id, lang, start_ms, end_ms, text, reference_source_id,
             1 - (embedding <=> ${len(params) - 1}::vector) AS score
      FROM chunks
      WHERE {' AND '.join(where)}
      ORDER BY embedding <=> ${len(params) - 1}::vector
      LIMIT ${len(params)}
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
    return [
        {
            "track_id": r["track_id"],
            "lang": r["lang"],
            "start_ms": r["start_ms"],
            "end_ms": r["end_ms"],
            "text": r["text"],
            "reference_source_id": r["reference_source_id"],
            "score": float(r["score"]),
        }
        for r in rows
    ]


async def recommend_next(
    *,
    user_context: UserContext | None = None,
    lang: str | None = None,
    top_k: int = 6,
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
    embedder = get_embedder()
    pool = get_pool()

    seed_ids = [t.track_id for t in user_context.recent_tracks[:5]]
    if not seed_ids:
        return []

    # Pull one representative chunk per seed (first chunk) for centroid.
    where_seed = ["embed_model = $1", "track_id = ANY($2::text[])"]
    params_seed: list[Any] = [embedder.name, seed_ids]
    if lang:
        where_seed.append(f"lang = ${len(params_seed) + 1}")
        params_seed.append(lang)
    sql_seed = f"""
      SELECT DISTINCT ON (track_id) track_id, embedding
      FROM chunks
      WHERE {' AND '.join(where_seed)}
      ORDER BY track_id, start_ms
    """
    async with pool.acquire() as conn:
        seed_rows = await conn.fetch(sql_seed, *params_seed)
    if not seed_rows:
        return []

    # Centroid (average of vectors). pgvector's asyncpg codec is registered
    # in `_init_connection` (db/client.py), so `embedding` arrives as a
    # list[float] / numpy array directly — no string-repr parsing needed.
    vecs: list[list[float]] = [list(r["embedding"]) for r in seed_rows]
    dim = len(vecs[0])
    centroid = [sum(v[i] for v in vecs) / len(vecs) for i in range(dim)]

    where = ["embed_model = $1", "track_id <> ALL($2::text[])"]
    params: list[Any] = [embedder.name, seed_ids]
    if lang:
        where.append(f"lang = ${len(params) + 1}")
        params.append(lang)
    params.append(centroid)
    params.append(max(1, min(top_k, 12)))
    sql = f"""
      SELECT DISTINCT ON (track_id) track_id, lang, start_ms, end_ms, text,
             1 - (embedding <=> ${len(params) - 1}::vector) AS score
      FROM chunks
      WHERE {' AND '.join(where)}
      ORDER BY track_id, embedding <=> ${len(params) - 1}::vector
      LIMIT ${len(params)}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
    return [
        {
            "track_id": r["track_id"],
            "lang": r["lang"],
            "start_ms": r["start_ms"],
            "end_ms": r["end_ms"],
            "text": r["text"],
            "score": float(r["score"]),
        }
        for r in rows
    ]


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
