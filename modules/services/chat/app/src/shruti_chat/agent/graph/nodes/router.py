"""Router node — calls `application/router_turn.py` and writes the
result into ChatState.

Thin adapter: 8 lines of real logic. The LLM-prompt and intent classifier
live in the use-case; this node just bridges state ↔ runtime.context.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.application.router_turn import run_router_turn
from shruti_chat.domain.turn_context import TurnContext
from shruti_chat.observability.logging import bind_node_role


async def router_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("router")
    ctx = runtime.context
    get_stream_writer()({"type": "status", "data": {"key": "thinking"}})
    decision = await run_router_turn(
        state["user_query"],
        lang=state["lang"],
        llm=ctx.llm,
        request_id=ctx.request_id,
        kv_cache=ctx.kv_cache,
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
