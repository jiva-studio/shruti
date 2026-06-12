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

import asyncio

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import (
    flush_card_payloads,
    run_worker,
    translate_commentaries,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role, get_logger
from lectorium_chat.research.corpus_fanout import dedup_notes_by_key
from lectorium_chat.research.pipeline import resolve_retrieval_lang, run_research


log = get_logger(__name__)


async def _derive_retrieval_lang(ctx: TurnContext, answer_lang: str) -> str:
    """Resolve the corpus-constrained retrieval language for `answer_lang`.
    Thin wrapper over the shared `research.pipeline.resolve_retrieval_lang`
    so the worker and the synthesis planner clamp identically."""
    return await resolve_retrieval_lang(
        ctx.chunk_repo, answer_lang, request_id=ctx.request_id
    )


async def research_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    ctx = runtime.context

    # Fallback path: if any required collaborator is missing (test
    # harness without pool/embedder/chunk_repo), keep the ReAct loop.
    if (
        ctx.chunk_repo is None
        or ctx.embedder is None
        or ctx.pool is None
        or ctx.embed_model is None
        or ctx.embed_dim is None
    ):
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

    # Retrieval language ≠ answer language. The corpus exists only in a
    # fixed set of languages (data-driven from `distinct_langs()`), and the
    # retrieval lane is strictly single-language (no cross-lang fallback) and
    # depends on per-(kind,lang) partial HNSW indexes. Passing a non-corpus
    # answer lang (uk / sr) — or None — would return empty results / trigger
    # a seq scan. So retrieval clamps to the answer lang IFF the corpus has
    # it, else English; the answer prose (ctx.lang) still goes out in `lang`.
    retrieval_lang = await _derive_retrieval_lang(ctx, lang)
    # Stash on ctx so the synthesizer knows the citation source language for
    # lazy commentary-card translation (translate only when it differs from
    # the answer language).
    ctx.retrieval_lang = retrieval_lang

    # Per-turn cross-encoder kill-switch (Stage A). Off ⇒ pass None so the
    # fanout runs the cosine path verbatim.
    enable_reranker = state.get("config", {}).get("enable_reranker", True)
    reranker = ctx.reranker if enable_reranker else None

    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "research_worker")
        if ctx.langfuse_trace_id
        else None
    )

    research_result = await run_research(
        question=user_query,
        lang=lang,
        retrieval_lang=retrieval_lang,
        router_args=router_args,
        chunk_repo=ctx.chunk_repo,
        catalog_repo=ctx.catalog_repo,
        embedder=ctx.embedder,
        alias_map=ctx.aliases,
        pool=ctx.pool,
        llm=ctx.llm,
        embed_model=ctx.embed_model,
        embed_dim=ctx.embed_dim,
        library_db=ctx.library_db_path,
        request_id=ctx.request_id,
        on_event=on_event,
        kv_cache=ctx.kv_cache,
        reranker=reranker,
        precomputed_query_embedding_task=ctx.embed_task,
        callbacks=[cb] if cb is not None else None,
    )

    # Flatten authoritative (PINNED) + research_chunks into a single
    # `tool_results` list, preserving order. The synthesizer reads them
    # as numbered Notes; putting authoritative first keeps the curator's
    # picks at the top of the prompt.
    #
    # Global de-dup by `_dedup_key` ((item_kind, item_id, segment_index) for
    # media / library, ("lecture", track_id, start/end) for lectures): the
    # SHORT/LONG paths each dedup within themselves, but a source can arrive
    # via BOTH authoritative_refs AND research_chunks (e.g. a media clip
    # pulled by topic refs and again by fanout), each having minted its own
    # alias. Without this collapse the synthesizer sees the same clip twice
    # under two `[^N]` markers and renders two identical cards. Keep the
    # first (authoritative-then-ranked) occurrence; drop later duplicates.
    tool_results = dedup_notes_by_key(
        list(research_result.authoritative_refs)
        + list(research_result.research_chunks)
    )

    # Emit verse_payload SSE events for any verse aliases minted during
    # fetch_refs / fanout. MUST happen BEFORE the synthesizer streams
    # `[^N]` markers — the mobile client expects the payload first.
    # Run the payload flushes concurrently with inline-commentary
    # pre-translation. All complete before the synthesizer streams, so the
    # ordering invariant (every `action` payload emitted BEFORE its marker)
    # holds. When MT is off, translate_commentaries / the in-flush translate
    # branches are no-ops, so this is the prior behaviour plus parallelism.
    await asyncio.gather(
        flush_card_payloads(ctx),
        translate_commentaries(ctx),
    )

    log.info(
        "research_worker_pipeline_complete",
        request_id=ctx.request_id,
        authoritative=len(research_result.authoritative_refs),
        research=len(research_result.research_chunks),
        matched_question_ids=research_result.matched_question_ids,
        matched_topic_ids=research_result.matched_topic_ids[:5],
    )
    return {"tool_results": tool_results}
