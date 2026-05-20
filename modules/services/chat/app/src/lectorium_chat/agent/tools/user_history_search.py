"""user_history_search — semantic search restricted to the user's history."""

from __future__ import annotations

from typing import Any

from lectorium_chat.agent.tools._envelope import lecture_to_envelope
from lectorium_chat.agent.tools._helpers import ok_or_no_ctx
from lectorium_chat.agent.tools._registry import ToolDef, register_tool
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain import UserContext
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort


_DESCRIPTION = (
    "Semantic search restricted to the user's recent listening history. "
    "Use when the user asks about content THEY specifically heard "
    "(\"что я слушал недавно про X\", \"тот ролик где он говорил про Y\"). "
    "Returns lecture chunks with refs cited via `[cite:N|caption]`."
)


async def user_history_search(
    query: str,
    *,
    user_context: UserContext | None = None,
    lang: str | None = None,
    top_k: int = 8,
    chunk_repo: ChunkRepository,
    embedder: EmbedderPort,
    alias_map: TurnAliasMap,
) -> list[dict[str, Any]] | dict[str, Any]:
    if user_context is None:
        return ok_or_no_ctx([], False)
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
        return [
            lecture_to_envelope(s.chunk, alias_map=alias_map, score=s.score)
            for s in scored
        ]

    rows = await _run(lang)
    if not rows and lang is not None:
        rows = await _run(None)
    return rows


register_tool(ToolDef(
    name="user_history_search",
    fn=user_history_search,
    personalized=True,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "lang":  {"type": "string", "enum": ["ru", "en"]},
            "top_k": {"type": "integer", "default": 8},
        },
        "required": ["query"],
    },
))
