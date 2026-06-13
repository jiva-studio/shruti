"""Router node — calls `application/router_turn.py` and writes the
result into ChatState.

Thin adapter: 8 lines of real logic. The LLM-prompt and intent classifier
live in the use-case; this node just bridges state ↔ runtime.context.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.classify import AddressClassifier, run_classifier_chain
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prior_refs import extract_prior_track_refs
from lectorium_chat.application.router_turn import run_router_turn
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role


# Deterministic classifiers tried before the LLM router. Stateless — built
# once. Each claims a query (high precision) or passes; on a pass we fall
# through to the LLM router below. The LLM is the LAST link in the chain.
_DETERMINISTIC_CHAIN = [AddressClassifier()]


async def router_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("router")
    ctx = runtime.context
    get_stream_writer()({"type": "status", "data": {"key": "thinking"}})

    # 1. Deterministic chain on the RAW query. A bare scripture reference
    #    ("БГ 2.13", "Мадхья лила 17.80") is resolved here without the LLM —
    #    the LLM router lossily collapses such refs (drops the CC lila), so
    #    reading the raw query is both cheaper and more correct.
    decision = await run_classifier_chain(
        _DETERMINISTIC_CHAIN, state["user_query"], ctx
    )

    # 2. LLM router fallback (the last chain link) for everything else.
    if decision is None:
        cb = langfuse_node_callback(ctx.langfuse_trace_id, "router") if ctx.langfuse_trace_id else None
        # Minimal conversation-context signal: did the prior assistant turn
        # surface track refs the user can point at? Disambiguates deictic
        # follow-ups and keys the router cache so they don't collide.
        prior_turn_had_refs = bool(extract_prior_track_refs(state.get("history")))
        decision = await run_router_turn(
            state["user_query"],
            lang=state["lang"],
            llm=ctx.llm,
            request_id=ctx.request_id,
            prior_turn_had_refs=prior_turn_had_refs,
            kv_cache=ctx.kv_cache,
            callbacks=[cb] if cb is not None else None,
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
    return {
        "intent": decision.intent,
        "confidence": decision.confidence,
        "extracted_args": decision.extracted_args,
    }
