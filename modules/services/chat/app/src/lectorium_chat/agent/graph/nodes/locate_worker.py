"""Locate worker — code-driven "where in scripture is this?" pipeline.

Thin adapter, mirroring `research_worker`: calls `research.locate.run_locate`
directly (no ReAct / LLM tool-selection — the router already chose `locate`),
turns the result into synthesizer notes, and flushes the chapter / verse SSE
payloads so the client renders `ChapterCard` / `VerseCard` from the payload
(titles never come from LLM prose).

Falls back to the ReAct loop over `locate_tools` only when the code-driven
collaborators (chunk_repo / embedder) are absent — keeps the node a drop-in
for older test harnesses.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import (
    flush_chapter_payloads,
    flush_verse_payloads,
    run_worker,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.domain.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger
from lectorium_chat.research.locate import run_locate
from lectorium_chat.research.models import LocateResult


log = get_logger(__name__)


def _chapter_range(chapter_tokens: list[str]) -> str:
    """Collapse chapter numbers into a compact range string for the
    LLM-facing note ("8–10", "5, 8–10"). The user-facing titles render in
    the ChapterCard; this is only context for the one-line lead-in."""
    nums: list[int] = []
    for tok in chapter_tokens:
        last = tok.split(",")[0].split(".")[-1]
        if last.isdigit():
            nums.append(int(last))
    nums = sorted(set(nums))
    if not nums:
        return ""
    runs: list[tuple[int, int]] = []
    start = prev = nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
            continue
        runs.append((start, prev))
        start = prev = n
    runs.append((start, prev))
    parts = [f"{a}–{b}" if a != b else f"{a}" for a, b in runs]
    return ", ".join(parts)


def _notes_from_result(result: LocateResult, aliases) -> list[dict]:
    """Mint aliases and build synthesizer notes from a LocateResult."""
    notes: list[dict] = []

    for region in result.regions:
        ref = aliases.alias_chapter(
            region.source_id,
            region.region_token,
            region.region_label,
            [(c.tokens, c.title) for c in region.chapters],
        )
        rng = _chapter_range([c.tokens for c in region.chapters])
        label = region.region_label or ""
        if rng:
            text = f"{label} — главы {rng}".strip(" —")
        else:
            text = label
        notes.append({"type": "location", "ref": ref, "text": text})

    if result.truncated:
        # Never let the ~4-region cap read as "this is everything".
        notes.append({
            "type": "location",
            "text": "(показаны основные места; есть и другие)",
        })

    for verse in result.verses:
        ref = aliases.alias_verse(verse.source_id, verse.tokens, addr_label=verse.addr_label)
        notes.append({
            "type": "verse",
            "ref": ref,
            "text": verse.addr_label or "",
            "meta": {"source_id": verse.source_id, "tokens": verse.tokens},
        })

    return notes


async def locate_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    ctx = runtime.context

    # Fallback: code-driven collaborators absent → ReAct over locate_tools.
    if ctx.chunk_repo is None or ctx.embedder is None:
        log.info("locate_worker_react_fallback", request_id=ctx.request_id)
        result = await run_worker(
            state, runtime,
            role="locate_worker",
            tools=ctx.locate_tools,
            status_key="locating",
        )
        return {"tool_results": result.tool_results}

    bind_node_role("locate_worker")
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "locating"}})

    def on_event(event_type: str, data: dict) -> None:
        writer({"type": event_type, "data": data})

    locate_result = await run_locate(
        question=state.get("user_query", ""),
        lang=state.get("lang", "ru"),
        router_args=state.get("extracted_args", {}) or {},
        chunk_repo=ctx.chunk_repo,
        embedder=ctx.embedder,
        pool=ctx.pool,
        llm=ctx.llm,
        embed_model=ctx.embed_model,
        embed_dim=ctx.embed_dim,
        library_db=ctx.library_db_path,
        request_id=ctx.request_id,
        on_event=on_event,
        precomputed_query_embedding_task=ctx.embed_task,
    )

    notes = _notes_from_result(locate_result, ctx.aliases)

    # Payloads MUST precede the inline markers in the delta stream.
    await flush_chapter_payloads(ctx)
    await flush_verse_payloads(ctx)

    log.info(
        "locate_worker_complete",
        request_id=ctx.request_id,
        regions=len(locate_result.regions),
        verses=len(locate_result.verses),
        matched_attribution_ids=locate_result.matched_attribution_ids,
    )
    return {"tool_results": notes}
