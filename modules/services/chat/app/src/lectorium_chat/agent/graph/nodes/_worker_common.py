"""Shared helpers for the worker nodes (research / catalog / action / help).

Every worker is a thin LangGraph adapter that:
  1. Looks up its toolset on `runtime.context` (different attr per worker).
  2. Emits a `status` event so the StatusPill on mobile reflects which
     phase of the turn is running.
  3. Builds the OpenAI-shape tool_schemas from the bound tools.
  4. Optionally renders an "anchor block" header that surfaces the
     UserContext details (focus_ref, current_track_ref, now, history
     summary) the inner LLM needs to pick context-aware tools.
  5. Calls the generic `run_react_loop` ReAct loop with the right
     tools + prompt + tool-event callback.

The use-case (`application/react_loop.py`) is purposely generic — the
"research" in the name is historical. It's the ReAct loop the worker
runs; toolset is parameterised.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Iterable

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prompts import build_prompt
from lectorium_chat.agent.turn_aliases import VerseRef
from lectorium_chat.application.react_loop import (
    DEFAULT_MAX_TURNS,
    ResearchResult,
    run_react_loop,
)
from lectorium_chat.domain.turn_context import TurnContext
from lectorium_chat.indexer.library.repo import fetch_verse_body
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


# Worker prompt sections — every tool-calling worker uses the same
# subset. The "voice" sections (citations, response_shape, language,
# safety, followups) shape the FINAL prose — only the synthesizer
# writes that, so they're omitted here. `actions` carries the
# `[action:kind|id=…]` marker protocol — action_worker NEEDS it; the
# others tolerate it (~100 lines is the cost of keeping the worker
# prompt uniform).
WORKER_PROMPT_SECTIONS = ("header", "tools", "actions", "quoting")


def tool_schemas_from(tools: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull OpenAI-format schemas from the registered ToolDefs for the
    subset of tools this worker actually has bound."""
    from lectorium_chat.agent.tools._registry import all_tools

    defs = all_tools()
    out: list[dict[str, Any]] = []
    for name in tools:
        td = defs.get(name)
        if td is None:
            log.warning("worker_tool_no_schema", tool=name)
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": td.name,
                    "description": td.description,
                    "parameters": td.parameters,
                },
            }
        )
    return out


def anchor_block(state: ChatState) -> str:
    """Render USER CONTEXT ANCHORS — the bits chat_turn.py wrapper
    extracted from UserContext. Without them the LLM can't know to
    call chunks_get_window (needs a track_ref), can't compute date
    windows for user_tracks_list (needs `now`), and won't realise
    `user_history_search` has anything to search.

    Empty string when no anchors are present — keeps the prompt
    small for trivial turns.
    """
    focus_ref = state.get("focus_ref")
    focus_around_ms = state.get("focus_around_ms")
    current_track_ref = state.get("current_track_ref")
    now_iso = state.get("now_iso")
    history_summary = state.get("history_summary")
    if (
        focus_ref is None
        and current_track_ref is None
        and now_iso is None
        and not history_summary
    ):
        return ""
    lines = ["\n\nUSER CONTEXT ANCHORS"]
    if now_iso is not None:
        lines.append(
            f"- now={now_iso} — the device's current time. Use it to "
            f"compute `since` / `until` ISO-8601 bounds when the user "
            f"asks «вчера / на этой неделе / a week ago»."
        )
    if history_summary is not None:
        lines.append(
            f"- listening_history: {history_summary}. The user HAS listened "
            f"to lectures.\n"
            f"  * \"что я недавно слушал про X\" / \"I heard about X "
            f"recently\" → `user_history_search(query=\"X\")` — REQUIRED: "
            f"pass `query` extracted from the user's phrasing (the topic "
            f"after \"про\" / \"about\"). E.g. user says «что я слушал про "
            f"карму» → query=\"карма\".\n"
            f"  * \"что я слушал на этой неделе\" / \"вчера\" / \"за месяц\" → "
            f"`user_tracks_list(since=\"<iso>\", until=\"<iso>\")` — compute "
            f"both bounds from `now` above.\n"
            f"  * \"что мне послушать дальше\" / \"recommend more\" → "
            f"`user_recommendations_get()` — no args.\n"
            f"  NEVER use `chunks_search` for these — it ignores the user's "
            f"history."
        )
    if current_track_ref is not None:
        lines.append(
            f"- current_track_ref={current_track_ref} — the lecture the user "
            f"is currently listening to. Pass this as `track_ref` when the "
            f"query is about \"this lecture\" / \"эта лекция\"."
        )
    if focus_ref is not None and focus_around_ms is not None:
        lines.append(
            f"- focus_ref={focus_ref}, around_ms={focus_around_ms} — the "
            f"user just tapped this fragment. For \"this fragment\" / "
            f"\"расскажи подробнее\" / \"что было до этого\" → call "
            f"`chunks_get_window(track_ref={focus_ref}, around_ms="
            f"{focus_around_ms})`. For \"найди похожее на этот фрагмент\" → "
            f"`chunks_find_similar(track_ref={focus_ref})`."
        )
    return "\n".join(lines) + "\n"


async def flush_verse_payloads(ctx: TurnContext) -> None:
    """Emit `action.kind=verse` events for every verse alias minted
    on this turn that hasn't been emitted yet — ordering invariant
    from plan section 11.5.1 (payload arrives BEFORE the inline
    `[^N]` marker in delta text).

    Called at the end of any worker that may have minted verse refs
    (research_worker calls chunks_search / chunks_get_by_address →
    minting). Catalog / action / help workers don't, but it's cheap
    to call anyway — the loop short-circuits on empty alias map.
    """
    if ctx.aliases is None or ctx.library_db_path is None:
        return
    writer = get_stream_writer()
    for ref_num, vref in ctx.aliases.verse_refs():
        if ref_num in ctx.emitted_verse_refs:
            continue
        ctx.emitted_verse_refs.add(ref_num)
        if not isinstance(vref, VerseRef):
            continue
        try:
            body = await fetch_verse_body(
                ctx.library_db_path, vref.source_id, vref.tokens
            )
        except Exception as exc:
            log.warning(
                "verse_payload_fetch_failed",
                request_id=ctx.request_id,
                source_id=vref.source_id,
                tokens=vref.tokens,
                error=str(exc),
            )
            continue
        if body is None:
            continue
        writer(
            {
                "type": "action",
                "data": {
                    "kind": "verse",
                    "id": f"verse_{vref.source_id}_{vref.tokens}",
                    "payload": {
                        "source_id": vref.source_id,
                        "tokens": vref.tokens,
                        "addr_label": vref.addr_label or "",
                        "sanskrit": body["sanskrit"],
                        "transliteration": body["transliteration"],
                        "translation": body["translation"],
                    },
                },
            }
        )


async def run_worker(
    state: ChatState,
    runtime: Runtime[TurnContext],
    *,
    role: str,
    tools: dict[str, Any],
    status_key: str,
    include_anchors: bool = True,
    max_turns: int = DEFAULT_MAX_TURNS,
    extra_user_query: str | None = None,
) -> ResearchResult:
    """Generic worker body: status → ReAct loop → flush verses.

    Returns the raw `ResearchResult` so the caller can decide what
    to put in state["tool_results"] (research/catalog/help append;
    action_worker may merge with prior research results).

    `extra_user_query` overrides `state["user_query"]` when set — used
    by action_worker which runs AFTER research and wants to ask
    "now compose the action from the tracks above" instead of repeating
    the original user prompt.
    """
    bind_node_role(role)
    ctx = runtime.context

    prompt_prefix = anchor_block(state) if include_anchors else ""
    system_prompt = prompt_prefix + build_prompt(WORKER_PROMPT_SECTIONS)
    schemas = tool_schemas_from(tools)

    writer = get_stream_writer()

    def _on_tool_event(event: str, tool_name: str) -> None:
        if event == "tool_start":
            writer({"type": "tool_start", "data": {"name": tool_name}})
        else:
            writer({"type": "tool_end", "data": {"name": tool_name}})

    def _yield_event(event_type: str, data: dict[str, Any]) -> None:
        """Bridge an emits_events tool's `yield_event(type, data)` call
        into a LangGraph custom-stream write so the SSE transport
        forwards it to the client. Without this hop the action_id the
        LLM gets back is never paired with an SSE `action` event, and
        the matching `[action:share_pdf|id=…]` marker in delta
        text renders as a broken card on mobile.
        """
        writer({"type": event_type, "data": data})

    writer({"type": "status", "data": {"key": status_key}})

    # Build the Langfuse callback ONCE per worker invocation. Inside
    # the ReAct loop each iteration calls `stream_completion` with the
    # SAME callback list — Langfuse aggregates the multi-step LLM
    # interactions under the worker's span. None when observability is
    # disabled; the LLM adapter then skips the `callbacks` kwarg.
    cb = langfuse_node_callback(ctx.langfuse_trace_id, role) if ctx.langfuse_trace_id else None
    callbacks_list = [cb] if cb is not None else None

    result = await run_react_loop(
        extra_user_query or state["user_query"],
        extracted_args=state.get("extracted_args", {}),
        lang=state["lang"],
        llm=ctx.llm,
        tools=tools,
        tool_schemas=schemas,
        aliases=ctx.aliases,
        system_prompt=system_prompt,
        request_id=ctx.request_id,
        max_turns=max_turns,
        on_tool_event=_on_tool_event,
        yield_event=_yield_event,
        callbacks=callbacks_list,
    )

    await flush_verse_payloads(ctx)
    return result
