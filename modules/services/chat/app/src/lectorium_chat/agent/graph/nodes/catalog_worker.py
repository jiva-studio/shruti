"""Catalog worker — deterministic catalog lookups (find_track intent).

Handles "lectures by X in Y", "что я слушал на этой неделе", "что мне
послушать дальше" — queries that need metadata filtering, not semantic
search. Toolset is the resolve_* + tracks_list + track_get +
user_tracks_list + user_recommendations_get subset.

router.intent="find_track" routes here. Like every worker, it appends
to `state["tool_results"]` and lets the synthesizer compose the reply.
"""

from __future__ import annotations

from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import run_worker
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext


# Catalog work is shallow — `resolve_X` then `tracks_list`, or a single
# `user_tracks_list` / `user_recommendations_get`. Cap at 5 so a
# misbehaving LLM can't burn 7 turns on lookups.
_MAX_TURNS = 5


async def catalog_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    result = await run_worker(
        state,
        runtime,
        role="catalog_worker",
        tools=runtime.context.catalog_tools,
        status_key="browsing_catalog",
        max_turns=_MAX_TURNS,
    )
    return {"tool_results": result.tool_results}
