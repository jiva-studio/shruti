"""Synthesis planner node — runs `outline_builder.build_outline` on the
notes accumulated by the research worker, writes the resulting `Outline`
(or `None`) back into state.

Sits BETWEEN `research_worker` and `synthesizer`. The synthesizer then
reads `state["outline"]` and switches its prompt accordingly:

- `outline = None`             → free-form synthesis (legacy behaviour)
- `Outline(theses=[])`         → deliberate refusal
- `Outline(theses=[…])`        → plan-driven prose (one paragraph per
                                  thesis, citing only its supporting_notes)

The node always runs — there's no feature flag — but a missing
`llm_synthesis_planner` setting, an LLM failure, or empty `tool_results`
all degrade gracefully to `outline=None`. This means the synthesizer's
legacy code path is reachable in every failure mode without any explicit
fallback wiring elsewhere.
"""

from __future__ import annotations

from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.domain.turn_context import TurnContext
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role, get_logger
from shruti_chat.research.outline_builder import build_outline


log = get_logger(__name__)


async def synthesis_planner_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("synthesis_planner")
    ctx = runtime.context

    tool_results = state.get("tool_results") or []
    if not tool_results:
        # No notes to plan over — let the synthesizer's existing
        # empty-tool_results handling take over (it already emits the
        # refusal text via `grounding.md` rules).
        log.info(
            "synthesis_planner_skip_no_notes",
            request_id=ctx.request_id,
        )
        return {"outline": None}

    if ctx.llm is None:
        log.warning(
            "synthesis_planner_skip_no_llm",
            request_id=ctx.request_id,
        )
        return {"outline": None}

    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "synthesis_planner")
        if ctx.langfuse_trace_id
        else None
    )

    # `model=None` lets `prompt_with_fallback` resolve the model from
    # Langfuse prompt-config (set to `llm_synthesis_planner` default at
    # bootstrap time) — same pattern as query_planner / topic_extractor.
    outline = await build_outline(
        state.get("user_query", ""),
        state.get("lang", "ru"),
        tool_results,
        llm=ctx.llm,
        model=None,
        callbacks=[cb] if cb is not None else None,
    )

    if outline is None:
        log.info(
            "synthesis_planner_outline_none",
            request_id=ctx.request_id,
            n_notes=len(tool_results),
        )
    else:
        log.info(
            "synthesis_planner_outline_built",
            request_id=ctx.request_id,
            n_notes=len(tool_results),
            n_theses=len(outline.theses),
            n_skipped=len(outline.skipped_notes),
            has_intro=outline.intro is not None,
        )

    return {"outline": outline}
