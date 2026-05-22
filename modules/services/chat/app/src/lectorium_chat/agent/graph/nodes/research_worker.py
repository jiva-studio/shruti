"""Research worker — code-driven research pipeline.

Replaces the LLM-driven ReAct loop with `research.pipeline.run_research`.
The graph topology, the node name, and the state contract are unchanged
(returns `{"tool_results": [...]}` so `route_after_research` and the
downstream synthesizer keep working). Catalog / action / help workers
still use the ReAct loop via `application/react_loop.py`.

If `chunk_repo` / `embedder` / `pool` aren't on TurnContext (older test
harnesses), we fall back to the legacy ReAct flow over `research_tools`
so this node remains a drop-in replacement.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import (
    flush_verse_payloads,
    run_worker,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.domain.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger
from lectorium_chat.research.pipeline import run_research


log = get_logger(__name__)


async def research_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    ctx = runtime.context

    # Fallback path: if any required collaborator is missing (test
    # harness without pool/embedder/chunk_repo), keep the ReAct loop.
    if ctx.chunk_repo is None or ctx.embedder is None or ctx.pool is None or ctx.embed_model is None:
        log.info("research_worker_react_fallback", request_id=ctx.request_id)
        result = await run_worker(
            state, runtime,
            role="research_worker",
            tools=ctx.research_tools,
            status_key="searching_corpus",
        )
        return {"tool_results": result.tool_results}

    # Code-driven path.
    bind_node_role("research_worker")
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "searching_corpus"}})

    # Bridge the pipeline (event_type, payload) callback to the
    # LangGraph stream writer. The pipeline emits `research_question`
    # and `research_source` events as sub-queries are generated and
    # sources are inspected, so the mobile client can render a live
    # "what's being investigated" panel under the streaming bubble.
    def on_event(event_type: str, data: dict) -> None:
        writer({"type": event_type, "data": data})

    user_query = state.get("user_query", "")
    lang = state.get("lang", "ru")
    router_args = state.get("extracted_args", {}) or {}

    research_result = await run_research(
        question=user_query,
        lang=lang,
        router_args=router_args,
        chunk_repo=ctx.chunk_repo,
        catalog_repo=ctx.catalog_repo,
        embedder=ctx.embedder,
        alias_map=ctx.aliases,
        pool=ctx.pool,
        llm=ctx.llm,
        embed_model=ctx.embed_model,
        request_id=ctx.request_id,
        on_event=on_event,
    )

    # Flatten authoritative (PINNED) + research_chunks into a single
    # `tool_results` list, preserving order. The synthesizer reads them
    # as numbered Notes; putting authoritative first keeps the curator's
    # picks at the top of the prompt.
    tool_results = list(research_result.authoritative_refs) + list(research_result.research_chunks)

    # Emit verse_payload SSE events for any verse aliases minted during
    # fetch_refs / fanout. MUST happen BEFORE the synthesizer streams
    # `[^N]` markers — the mobile client expects the payload first.
    await flush_verse_payloads(ctx)

    log.info(
        "research_worker_pipeline_complete",
        request_id=ctx.request_id,
        authoritative=len(research_result.authoritative_refs),
        research=len(research_result.research_chunks),
        matched_question_ids=research_result.matched_question_ids,
        matched_topic_ids=research_result.matched_topic_ids[:5],
    )
    return {"tool_results": tool_results}
