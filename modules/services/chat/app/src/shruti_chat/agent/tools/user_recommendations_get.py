"""user_recommendations_get — centroid-based recommendations from history."""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._envelope import lecture_to_envelope
from shruti_chat.agent.tools._helpers import ok_or_no_ctx
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain import UserContext
from shruti_chat.domain.ports.chunk_repository import ChunkRepository


_DESCRIPTION = (
    "Recommend lecture chunks based on what the user listened to "
    "recently. Computes the centroid of the first chunks of their last "
    "5 tracks and ANN-searches the rest of the corpus excluding those "
    "seeds. Use when the user asks 'что мне послушать дальше', "
    "'порекомендуй', 'continue exploring'. Requires user_context with "
    "non-empty recent listening. For 'recommend something like THIS "
    "lecture' (no user history needed) use `chunks_find_similar` with "
    "just `track_ref`."
)


async def user_recommendations_get(
    *,
    user_context: UserContext | None = None,
    lang: str | None = None,
    top_k: int = 6,
    chunk_repo: ChunkRepository,
    alias_map: TurnAliasMap,
) -> list[dict[str, Any]] | dict[str, Any]:
    if user_context is None:
        return ok_or_no_ctx([], False)
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
        return [
            lecture_to_envelope(s.chunk, alias_map=alias_map, score=s.score)
            for s in scored
        ]

    rows = await _run(lang)
    if not rows and lang is not None:
        rows = await _run(None)
    return rows


register_tool(ToolDef(
    name="user_recommendations_get",
    fn=user_recommendations_get,
    personalized=True,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "lang":  {"type": "string", "enum": ["ru", "en"]},
            "top_k": {"type": "integer", "default": 6},
        },
    },
))
