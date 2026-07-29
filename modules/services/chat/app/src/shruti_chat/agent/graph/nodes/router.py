"""Router node — calls `application/router_turn.py` and writes the
result into ChatState.

Thin adapter: 8 lines of real logic. The LLM-prompt and intent classifier
live in the use-case; this node just bridges state ↔ runtime.context.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.classify import (
    AddressClassifier,
    LectureUrlClassifier,
    run_classifier_chain,
)
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prior_refs import extract_prior_track_refs
from shruti_chat.application.followup_rewrite import resolve_followup_query
from shruti_chat.application.router_turn import run_router_turn
from shruti_chat.domain.routing import RoutingDecision
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


# Deterministic classifiers tried before the LLM router. Stateless — built
# once. Each claims a query (high precision) or passes; on a pass we fall
# through to the LLM router below. The LLM is the LAST link in the chain.
_DETERMINISTIC_CHAIN = [AddressClassifier(), LectureUrlClassifier()]


async def router_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("router")
    ctx = runtime.context
    get_stream_writer()({"type": "status", "data": {"key": "thinking"}})

    # 1. Deterministic chain on the RAW query first. A bare scripture reference
    #    ("БГ 2.13", "Мадхья лила 17.80") is resolved here without the LLM —
    #    the LLM router lossily collapses such refs (drops the CC lila), so
    #    reading the raw query is both cheaper and more correct. Running it
    #    BEFORE the follow-up rewrite also protects the show_verse fast path:
    #    the rewriter tends to dress «БГ 2.13» up as «Что говорится в БГ 2.13?»,
    #    which is no longer a bare address.
    query = state["user_query"]
    decision = await run_classifier_chain(_DETERMINISTIC_CHAIN, query, ctx)

    # 2. Fall-through (no deterministic hit). Resolve a context-dependent
    #    follow-up into a self-contained query BEFORE the LLM router. The
    #    router + retrieval read the current message alone, so «А ещё?» after
    #    an asura answer would route to direct_chat and answer ungrounded;
    #    rewriting it to «Ещё стихи БГ о природе асуров» lets the rest of the
    #    pipeline work on a real query. Gated (history + short message) so
    #    normal turns pay no extra call. Re-run the chain on the rewrite so a
    #    follow-up that resolves to a bare ref ("а ещё БГ 2.13?") still takes
    #    the show_verse fast path.
    if decision is None:
        rewritten = await resolve_followup_query(
            state.get("history"),
            state["user_query"],
            llm=ctx.llm,
            request_id=ctx.request_id,
        )
        if rewritten != query:
            query = rewritten
            decision = await run_classifier_chain(_DETERMINISTIC_CHAIN, query, ctx)

    # 3. LLM router fallback (the last chain link) for everything else.
    if decision is None:
        cb = langfuse_node_callback(ctx.langfuse_trace_id, "router") if ctx.langfuse_trace_id else None
        # Minimal conversation-context signal: did the prior assistant turn
        # surface track refs the user can point at? Disambiguates deictic
        # follow-ups and keys the router cache so they don't collide.
        prior_turn_had_refs = bool(extract_prior_track_refs(state.get("history")))
        # Player-context signals so the classifier sets deictic flags
        # consistently with reality (don't flag current_ref with nothing open,
        # or recent_ref/history_ref with no listen-log). Both are already in
        # state: current_track_ref (minted from user_context.current_track_id)
        # and history_summary (from user_context.recent_tracks).
        has_current_track = bool(state.get("current_track_ref"))
        has_recent_history = bool(state.get("history_summary"))
        # A genuine parse failure (structured-output retries + fallback model
        # + JSON salvage all exhausted) raises out of run_router_turn. The
        # domain design says `unknown` is the intended soft fallback — a failed
        # classification must NOT kill the whole turn. Catch and degrade so the
        # turn proceeds down the documented synthesizer path.
        try:
            decision = await run_router_turn(
                query,
                lang=state["lang"],
                llm=ctx.llm,
                request_id=ctx.request_id,
                prior_turn_had_refs=prior_turn_had_refs,
                has_current_track=has_current_track,
                has_recent_history=has_recent_history,
                kv_cache=ctx.kv_cache,
                callbacks=[cb] if cb is not None else None,
            )
        except Exception:
            log.exception(
                "router_turn_failed_soft_fallback_unknown",
                request_id=ctx.request_id,
            )
            decision = RoutingDecision(
                intent="unknown", confidence=0.0, extracted_args={},
            )
    # Cancel the speculative embed task for intents that don't consume
    # the embedding. Saves one OpenRouter call per direct_chat / help /
    # create_action turn; on research / find_track / unknown we leave
    # it running so the worker can await its result.
    if ctx.embed_task is not None and decision.intent not in {
        "research",
        "find_track",
        "unknown",
    }:
        ctx.embed_task.cancel()
        ctx.embed_task = None
    # Surface the routing decision as an SSE `status` event. The API layer
    # (`api/chat.py`) and the Langfuse `router_intent` score both look for a
    # `status` event with key=router_decision / params.intent — without this
    # emit the help-quota refund path is dead code and the intent is never
    # observable. Emitted for every path (deterministic, follow-up, LLM).
    get_stream_writer()(
        {"type": "status", "data": {"key": "router_decision", "params": {"intent": decision.intent}}}
    )
    return {
        "intent": decision.intent,
        "confidence": decision.confidence,
        "extracted_args": decision.extracted_args,
        # Persist the resolved query so the worker + synthesizer retrieve and
        # answer the self-contained form, not the bare follow-up.
        "user_query": query,
    }
