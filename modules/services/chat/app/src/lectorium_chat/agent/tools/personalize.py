"""Personalization tools — read from `user_context` injected via closure.

`user_context` is a pydantic `api.chat.UserContext` instance (or None). It
carries:
- recent_tracks: list of (track_id, last_played_at, percent, ...)
- in_progress: subset of recent with 0.05 < percent < 0.95
- current_track_id: what user is listening to right now (or just stopped)
- recent_notes: last ~30 user notes (with track_id, time range, text)

These tools are exposed to the LLM with NO `user_context` parameter in
their JSON-Schema — the loop binds it via `build_personalized_tools`.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from lectorium_chat.db.client import get_pool
from lectorium_chat.domain import UserContext
from lectorium_chat.indexer.embed import get_embedder


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
    """Top-3 unfinished tracks from `in_progress`, ordered by recency."""
    if user_context is None:
        return _ok_or_empty([], False)
    # Filter to a reasonable mid-progress window.
    filtered = [
        t for t in user_context.in_progress
        if (t.percent is None) or (0.05 < (t.percent or 0) < 0.95)
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


def _cosine(a: Iterable[float], b: Iterable[float]) -> float:
    al = list(a); bl = list(b)
    if not al or not bl or len(al) != len(bl):
        return 0.0
    dot = sum(x * y for x, y in zip(al, bl))
    na = math.sqrt(sum(x * x for x in al))
    nb = math.sqrt(sum(y * y for y in bl))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def search_my_notes(
    query: str,
    *,
    user_context: UserContext | None = None,
    top_k: int = 8,
) -> dict[str, Any] | list[dict[str, Any]]:
    """Semantic ranking over notes the user already wrote.

    Note text is in the request body — we embed query + each note once and
    sort. With <=30 notes this is microseconds.
    """
    if user_context is None:
        return _ok_or_empty([], False)
    notes = user_context.recent_notes
    if not notes:
        return []
    embedder = get_embedder()
    q_vec = await embedder.embed_query(query)
    note_vecs = await embedder.embed_documents([n.text for n in notes])
    scored = sorted(
        (
            (
                _cosine(q_vec, v),
                {
                    "track_id": n.track_id,
                    "time_start_ms": n.time_start_ms,
                    "time_end_ms": n.time_end_ms,
                    "text": n.text,
                    "created_at": n.created_at,
                },
            )
            for v, n in zip(note_vecs, notes)
        ),
        key=lambda p: p[0],
        reverse=True,
    )
    return [{"score": s, **payload} for s, payload in scored[: max(1, min(top_k, 16))]]


async def recommend_next(
    *,
    user_context: UserContext | None = None,
    based_on_track_id: str | None = None,
    lang: str | None = None,
    top_k: int = 6,
) -> dict[str, Any] | list[dict[str, Any]]:
    """ANN from a centroid of the user's recent listening.

    If `based_on_track_id` is given, use chunks from that track only.
    Otherwise take centroid of last 5 recent tracks' first chunks.
    """
    if user_context is None and not based_on_track_id:
        return _ok_or_empty([], False)
    embedder = get_embedder()
    pool = get_pool()

    # Decide seed track_ids.
    seed_ids: list[str] = []
    if based_on_track_id:
        seed_ids = [based_on_track_id]
    elif user_context is not None:
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

    # Centroid (average of vectors). pgvector returns string repr; cast via float list.
    vecs: list[list[float]] = []
    for r in seed_rows:
        v = r["embedding"]
        if isinstance(v, str):
            v = [float(x) for x in v.strip("[]").split(",")]
        vecs.append(list(v))
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
            "Recommend tracks similar to what the user recently listened to. "
            "Pass `based_on_track_id` to anchor on one specific track; "
            "otherwise uses centroid of last 5 recent tracks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "based_on_track_id": {"type": "string"},
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
    {
        "name": "search_my_notes",
        "fn": search_my_notes,
        "personalized": True,
        "description": (
            "Semantic ranking over notes the user has saved. Use for 'what "
            "did I write about X'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "top_k": {"type": "integer", "default": 8},
            },
            "required": ["query"],
        },
    },
]
