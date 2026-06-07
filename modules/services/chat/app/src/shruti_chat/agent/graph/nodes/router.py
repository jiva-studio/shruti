"""Router node — calls `application/router_turn.py` and writes the
result into ChatState.

Thin adapter: 8 lines of real logic. The LLM-prompt and intent classifier
live in the use-case; this node just bridges state ↔ runtime.context.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prior_refs import extract_prior_track_refs
from shruti_chat.application.router_turn import run_router_turn
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role


async def router_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("router")
    ctx = runtime.context
    get_stream_writer()({"type": "status", "data": {"key": "thinking"}})
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
