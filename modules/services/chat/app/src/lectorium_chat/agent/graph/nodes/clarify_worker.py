"""Clarify worker — a deterministic terminal for a deictic request the server
can't ground because the needed personal context is absent.

Reached from `route_after_router` when the router flagged a deictic pointer at
the user's own listening — «где остановился», «перескажи текущую лекцию»,
«что я слушал на неделе», «что послушать ещё» — but there is NO real anchor to
resolve it against: `current_track_ref` is unset (no lecture open) and/or the
listen-history is empty (`history_summary` is None). Without this the request
fell through to a corpus worker that blind-searches for "the last lecture" and
refuses with a confusing "not found" (#4/#44/#46 family).

Instead of that dead-end we ask ONE short, grounded question in the user's
language — name a lecture, or a topic/author/book — so the next turn is
answerable. Deterministic (no LLM), so it streams instantly. Terminal → END.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)

# Two shapes of missing context, each localized (en is the fallback):
#  - "which lecture" — the user pointed at a specific lecture (current/recent)
#    we can't see (no sync / nothing playing).
#  - "no history" — the user asked over their listen-log / for a recommendation
#    but we have no history to work from.
_WHICH_LECTURE: dict[str, str] = {
    "ru": (
        "Я не вижу, какую лекцию вы слушаете — включите синхронизацию "
        "прослушивания или назовите лекцию, и я продолжу."
    ),
    "en": (
        "I can't tell which lecture you mean — enable listening sync or name "
        "the lecture, and I'll continue."
    ),
}
_NO_HISTORY: dict[str, str] = {
    "ru": (
        "Пока не вижу вашей истории прослушивания. Назовите тему, автора или "
        "книгу — и я подберу лекции."
    ),
    "en": (
        "I don't see your listening history yet. Name a topic, author, or book "
        "and I'll find lectures."
    ),
}


async def clarify_worker_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("clarify_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "composing_answer"}})

    args = state.get("extracted_args") or {}
    # `current_ref` / `recent_ref` point at a specific lecture; `history_ref` and
    # the recommend path are about the listen-log as a whole.
    points_at_lecture = bool(args.get("current_ref") or args.get("recent_ref"))
    table = _WHICH_LECTURE if points_at_lecture else _NO_HISTORY
    log.info(
        "clarify_deictic",
        request_id=ctx.request_id,
        kind="which_lecture" if points_at_lecture else "no_history",
        intent=state.get("intent"),
    )
    writer({"type": "delta", "data": {"text": table.get(ctx.lang, table["en"])}})
    return {}
