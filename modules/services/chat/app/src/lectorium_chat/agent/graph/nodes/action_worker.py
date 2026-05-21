"""Action worker — turns prior search results into a client-side card.

Runs AFTER research_worker on a `create_action` intent. The chain is
`router → research_worker → action_worker → synthesizer`. By the time
this node fires, `state["tool_results"]` already holds the candidate
tracks the research_worker found; this worker calls one of the
`*_propose` tools to produce the action card payload, and appends
the action result so the synthesizer can render the inline
`[action:kind|id=…]` marker.

Toolset is narrow on purpose: track_pdf_generate
and the three hint kinds (reminder / smart_library / pro_upgrade).
Two turns max — one to dispatch the propose call, one to converge.
"""

from __future__ import annotations

from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import run_worker
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.domain.turn_context import TurnContext


_MAX_TURNS = 2


async def action_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    result = await run_worker(
        state,
        runtime,
        role="action_worker",
        tools=runtime.context.action_tools,
        status_key="preparing_action",
        max_turns=_MAX_TURNS,
        # The original user query stays — the prior research_worker
        # results live in `state["tool_results"]` which the synthesizer
        # reads at the end. We don't repeat them in the worker prompt
        # because that would just re-trigger the LLM to call search
        # tools again. The action_worker prompt focuses purely on
        # "which propose_* fits this user intent".
    )
    # Append, don't replace — research_worker's results stay in state
    # so the synthesizer can cite both the tracks AND the action.
    return {"tool_results": result.tool_results}
