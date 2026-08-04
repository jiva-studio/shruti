"""Recommend worker — deterministic "what to listen next" (intent=recommend).

Reached when the router classifies a next-track recommendation request
(«что послушать дальше», "what should I listen to next?"). Unlike the
catalog worker, this runs NO LLM ReAct loop: the lecture selection is the
same topic-affinity algorithm the mobile app uses
(`application/recommend.py`, a port of `buildRecommendations.ts`). The
only LLM hop is the shared synthesizer pass that phrases the lead-in
(«недавно вы слушали про X — вот похожее») in the user's language and
adds follow-up chips.

It appends to `state["tool_results"]`:
- when there's history: a directive note naming the hot topics + one
  `[^N]` lecture card per recommended track (minted via
  `aliases.alias_track`, so the client renders the whole-lecture card
  from its own catalog DB);
- when there's none: a single directive note telling the synthesizer to
  ask the user to listen to a few lectures first — the honest answer,
  not a blind recommendation.
"""

from __future__ import annotations

from dataclasses import replace

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.application.recommend import recommend_tracks
from shruti_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)


_NO_HISTORY_NOTE = (
    "NO LISTENING HISTORY — the user asked what to listen to next, but they "
    "have not listened to any lectures yet, so there is nothing to base a "
    "recommendation on. In the user's language, in 1-2 short sentences, tell "
    "them you'll be able to recommend lectures once they've listened to a "
    "few, and invite them to start by searching for a topic that interests "
    "them. Do NOT fabricate any lecture cards, titles, or topics."
)


def _recommendation_directive(topic_list: str) -> str:
    return (
        "RECOMMENDATIONS — the user asked what to listen to next. Based on "
        "their recent listening they have been exploring these topics: "
        f"{topic_list}. The lectures below (each a [^N] card) are unheard "
        "talks on those topics. In the user's language: write ONE short "
        "sentence saying you're suggesting lectures on the topics they have "
        "recently been listening to (name the topics), then list EVERY "
        "lecture card below — each [^N] marker on its own line. Do not invent "
        "titles, topics, or any lecture not listed below."
    )


async def recommend_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("recommend_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "browsing_catalog"}})

    if ctx.catalog_repo is None:
        log.warning("recommend_no_catalog_repo", request_id=ctx.request_id)
        return {"tool_results": [{"text": _NO_HISTORY_NOTE}]}

    rec = await recommend_tracks(
        user_context=ctx.user_context,
        catalog=ctx.catalog_repo,
        # Single language — recommend lectures the user can actually read in
        # the answer language (an English clip is useless to a Russian user).
        languages=[ctx.lang],
    )

    # The author selection applies to a recommendation like any other lecture
    # retrieval. Filtered AFTER the recommender ranked, because it scores by
    # topic affinity and has no author predicate — so a narrow selection simply
    # yields a shorter list rather than a differently-ranked one.
    if ctx.author_scope is not None:
        allowed = await ctx.author_scope.narrow(list(rec.track_ids))
        if allowed is not None and list(allowed) != list(rec.track_ids):
            rec = replace(rec, track_ids=tuple(allowed))

    if not rec.has_history or not rec.track_ids:
        log.info(
            "recommend_no_history",
            request_id=ctx.request_id,
            has_history=rec.has_history,
            n_tracks=len(rec.track_ids),
        )
        return {"tool_results": [{"text": _NO_HISTORY_NOTE}]}

    # Topic names for the lead-in. Missing names are skipped; if none
    # resolve we still recommend (the synthesizer just won't name topics).
    names = await ctx.catalog_repo.topic_names(list(rec.hot_topic_ids), lang=ctx.lang)
    topic_list = ", ".join(
        names[tid] for tid in rec.hot_topic_ids if tid in names
    ) or "—"

    # Titles help the synthesizer write grounded prose; the card itself
    # renders client-side from the alias' track_id, so a missing title is
    # harmless (the [^N] card still appears).
    titles = await ctx.catalog_repo.get_titles(list(rec.track_ids), lang=ctx.lang)

    notes: list[dict] = [{"text": _recommendation_directive(topic_list)}]
    for tid in rec.track_ids:
        ref = ctx.aliases.alias_track(tid)
        notes.append({"type": "lecture", "ref": ref, "title": titles.get(tid, "")})

    log.info(
        "recommend_ok",
        request_id=ctx.request_id,
        n_tracks=len(rec.track_ids),
        n_topics=len(rec.hot_topic_ids),
    )
    return {"tool_results": notes}
