"""Application use-case: run one chat turn through the LangGraph chat graph.

This file used to drive `run_llm_loop` directly. Stage 1 of the
multi-agent migration replaces that with a compiled LangGraph
StateGraph (router → research_worker → synthesizer). The chat_turn
function owns the surrounding plumbing the graph doesn't:

- pre-mint `focus_ref` / `current_track_ref` so user-context ids
  never leak to the LLM as raw track ids
- build the `TurnContext` (per-turn services) the graph nodes pull
  from `runtime.context`
- bridge the graph's `astream` events into the existing `AgentEvent`
  SSE stream (so api/chat.py is unchanged)
- final terminal events: aliases map + done
- post-turn bypass-marker audit (catches the LLM typing
  `[cite:track_X@...]` directly instead of going through the
  numbered-ref protocol)

The external signature is unchanged so api/chat.py + run_proactive_turn
keep working.
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator, Awaitable, Callable

from lectorium_chat.agent.aliased_tools import build_aliased_tools
from lectorium_chat.agent.events import AgentEvent
from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.tools import TOOLS, build_personalized_tools
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.composition import AppDeps
from lectorium_chat.domain import UserContext
from lectorium_chat.domain.turn_context import TurnContext
from lectorium_chat.observability.logging import (
    bind_turn_context,
    clear_turn_context,
    get_logger,
)


log = get_logger(__name__)


# Per-worker tool subsets — one bag, sliced by name per graph node.
# Splitting cuts each worker's tool-menu to ~5-7 entries instead of
# 17, which improves tool-selection accuracy on weaker models.
_RESEARCH_TOOL_NAMES = frozenset({
    "chunks_search",
    "chunks_get_by_address",
    "chunks_get_window",
    "chunks_find_similar",
    "user_history_search",
    "track_outline_get",
})
_CATALOG_TOOL_NAMES = frozenset({
    "author_resolve",
    "source_resolve",
    "location_resolve",
    "tag_resolve",
    "tracks_list",
    "track_get",
    "user_tracks_list",
    "user_recommendations_get",
})
_ACTION_TOOL_NAMES = frozenset({
    "playlist_propose",
    "track_pdf_generate",
    "reminder_propose",
    "smart_library_propose",
    "pro_upgrade_propose",
})
_HELP_TOOL_NAMES = frozenset({
    "help_get",
})


def _subset(
    tools: dict[str, Any], names: frozenset[str]
) -> dict[str, Any]:
    """Pick the named subset out of the full tool bag. Silently drop
    names that aren't bound (e.g. an action tool that didn't register
    because its dependency is unavailable) so partial deploys don't
    crash the graph at build time."""
    return {n: tools[n] for n in names if n in tools}


# Inline chip-class markers the LLM is FORBIDDEN to write directly —
# it must use the numbered-ref protocol (`[cite:N]`, `[card:N]`, ...)
# and the MarkerExpander expands those into the real track-id form
# below before they hit the client. Anything matching these regexes
# in the LLM-typed prose means the model bypassed the protocol — log
# the slip for prompt-engineering follow-up.
_CITE_MARKER_RE = re.compile(r"\[cite:([A-Za-z0-9_.-]+)@\d+-\d+(?:\|[^\]]*)?\]")
_CARD_MARKER_RE = re.compile(r"\[card:([A-Za-z0-9_.-]+)\]")
_OUTLINE_MARKER_RE = re.compile(r"\[outline:([A-Za-z0-9_.-]+)\]")


async def _audit_bypass_markers(
    llm_prose: str,
    *,
    deps: AppDeps | None,
    request_id: str | None,
) -> None:
    """Log every chip-class marker the LLM typed in prose. With the
    numbered-ref protocol active the correct path injects markers via
    `propose_*` tool side-events; anything in the LLM-prose buffer is
    an instruction-following slip we want visible in metrics."""
    findings: list[tuple[str, str]] = []
    for m in _CITE_MARKER_RE.finditer(llm_prose):
        findings.append(("cite", m.group(1)))
    for m in _CARD_MARKER_RE.finditer(llm_prose):
        findings.append(("card", m.group(1)))
    for m in _OUTLINE_MARKER_RE.finditer(llm_prose):
        findings.append(("outline", m.group(1)))
    if not findings:
        return

    valid: set[str] = set()
    if deps is not None:
        all_ids = list({tid for _, tid in findings})
        try:
            valid = set(await deps.catalog_repo.filter_existing_track_ids(all_ids))
        except Exception as exc:
            log.warning(
                "bypass_audit_validation_failed",
                request_id=request_id,
                error=str(exc),
            )
    for kind, tid in findings:
        log.info(
            "chat_marker_bypassed_tool",
            request_id=request_id,
            kind=kind,
            track_id=tid,
            in_catalog=tid in valid,
        )


def _extract_latest_user_query(history: list[dict[str, Any]]) -> str:
    """The router and workers only need the current question — pull it
    out so we don't have to thread the whole history into their inner
    LLM calls. Synthesizer DOES get the full history (folded down to
    user-visible text by `fold_history`) so the assistant remembers
    prior exchanges; that fan-out lives in `state["history"]` →
    `synthesizer_turn`.
    """
    for entry in reversed(history):
        if entry.get("role") == "user" and isinstance(entry.get("content"), str):
            return entry["content"]
    return ""


async def run_chat_turn(
    history: list[dict[str, Any]],
    *,
    lang: str = "ru",
    request_id: str | None = None,
    user_context: UserContext | None = None,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    deps: AppDeps | None = None,
) -> AsyncIterator[AgentEvent]:
    """Drive one chat turn through the LangGraph chat graph.

    Same shape as the legacy monolithic loop: takes history + lang +
    request_id, yields `AgentEvent`s. The graph internals are hidden
    behind the `astream` event bridge below.
    """
    if deps is None or deps.chat_graph is None or deps.llm is None:
        raise RuntimeError(
            "run_chat_turn requires AppDeps with chat_graph + llm "
            "(lifespan must have built them)"
        )

    trace_id = request_id or "anon"
    bind_turn_context(trace_id=trace_id, request_id=request_id, agent_role="main")

    try:
        # ── Build per-turn services (aliases + expander + tools) ──────
        aliases = TurnAliasMap()
        # Pre-mint refs for `current_track_id` and `focus.track_id` so
        # the LLM sees integer refs throughout the turn, not raw ids.
        # Capture the minted integers — workers' system prompts surface
        # them as anchor metadata so the LLM can pass them straight into
        # chunks_get_window / chunks_find_similar.
        current_track_ref: int | None = None
        focus_ref: int | None = None
        focus_around_ms: int | None = None
        now_iso: str | None = None
        history_summary: str | None = None
        if user_context is not None:
            if user_context.current_track_id:
                current_track_ref = aliases.alias_track(user_context.current_track_id)
            if user_context.focus is not None:
                focus_ref = aliases.alias_chunk(
                    user_context.focus.track_id,
                    int(user_context.focus.start_ms),
                    int(user_context.focus.end_ms),
                )
                focus_around_ms = (
                    int(user_context.focus.start_ms) + int(user_context.focus.end_ms)
                ) // 2
            if user_context.now is not None:
                now_iso = user_context.now.isoformat()
            if user_context.recent_tracks:
                in_prog = len(user_context.in_progress_tracks())
                history_summary = (
                    f"recent={len(user_context.recent_tracks)} "
                    f"in_progress={in_prog}"
                )

        # Per-worker tool subsets — each graph node gets a narrow toolset
        # so the LLM picks from a smaller menu and tool-selection
        # accuracy goes up. The full bag is aliased once; we then slice
        # by name per worker (the aliasing is idempotent and the shared
        # alias map keeps refs consistent across workers in the same
        # turn).
        all_tools = build_personalized_tools(TOOLS, user_context)
        aliased_tools = build_aliased_tools(all_tools, aliases)
        research_tools = _subset(aliased_tools, _RESEARCH_TOOL_NAMES)
        catalog_tools = _subset(aliased_tools, _CATALOG_TOOL_NAMES)
        action_tools = _subset(aliased_tools, _ACTION_TOOL_NAMES)
        help_tools = _subset(aliased_tools, _HELP_TOOL_NAMES)

        expander = MarkerExpander(aliases, request_id=request_id)

        ctx = TurnContext(
            request_id=trace_id,
            aliases=aliases,
            expander=expander,
            llm=deps.llm,
            research_tools=research_tools,
            catalog_tools=catalog_tools,
            action_tools=action_tools,
            help_tools=help_tools,
            library_db_path=deps.settings.library_db_path,
        )

        initial_state: dict[str, Any] = {
            "history": history,
            "user_query": _extract_latest_user_query(history),
            "lang": lang,
            "request_id": trace_id,
            "tool_results": [],
            "focus_ref": focus_ref,
            "focus_around_ms": focus_around_ms,
            "current_track_ref": current_track_ref,
            "now_iso": now_iso,
            "history_summary": history_summary,
        }

        # ── Drive the graph; bridge custom events to AgentEvents ─────
        full_prose: list[str] = []
        try:
            async for mode, payload in deps.chat_graph.astream(
                initial_state,
                context=ctx,
                stream_mode=["custom"],
            ):
                if mode != "custom":
                    continue
                # All node-writer emissions have shape {type, data}.
                ev_type = payload.get("type")
                ev_data = payload.get("data", {})
                if not ev_type:
                    continue
                if ev_type == "delta":
                    full_prose.append(ev_data.get("text", ""))
                yield AgentEvent(type=ev_type, data=ev_data)
                # Co-op cancellation if the client closed the SSE.
                if is_disconnected is not None and await is_disconnected():
                    log.info(
                        "chat_cancelled_mid_stream",
                        request_id=request_id,
                        prose_chars=sum(len(s) for s in full_prose),
                    )
                    return
        except Exception as exc:
            log.exception("chat_graph_failed", request_id=request_id, error=str(exc))
            yield AgentEvent(
                type="error",
                data={"code": "agent_error", "message": str(exc)},
            )
            return

        # ── Flush any partial-marker tail still in expander ──────────
        tail = await expander.flush()
        if tail:
            yield AgentEvent(type="delta", data={"text": tail})
            full_prose.append(tail)

        # ── Bypass-marker audit (off the hot path) ───────────────────
        await _audit_bypass_markers(
            "".join(full_prose),
            deps=deps,
            request_id=request_id,
        )

        # ── Terminal `done` carries the alias map inline ─────────────
        # v1 protocol: client persists `done.data.aliases` on the
        # freshly-finalised assistant message and ships it back on the
        # next turn so `_fold_prior_assistant_content` rewrites chip
        # markers in history into `[cite:N|...]` form.
        done_data: dict[str, Any] = {}
        if len(aliases) > 0:
            done_data["aliases"] = aliases.serialize()
        yield AgentEvent(type="done", data=done_data)

    finally:
        clear_turn_context()
