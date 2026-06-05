"""Action worker — turns prior search results into a client-side card.

Runs AFTER research_worker on a `create_action` intent. The chain is
`router → research_worker → action_worker → synthesizer`. By the time
this node fires, `state["tool_results"]` already holds the candidate
tracks the research_worker found; this worker calls one of the
`*_propose` tools to produce the action card payload, and appends
the action result so the synthesizer can render the inline
`[action:kind|id=…]` marker.

Toolset is narrow on purpose: track_pdf_generate and the three hint
kinds (reminder / smart_library / pro_upgrade). Two turns max — one
to dispatch the propose call, one to converge.

Multi-turn deictic resolution: when the user says «PDF этих лекций»,
the LLM can't know which "этих" refers to because `fold_history`
strips the `[card:X]` markers from the prior turn. We pre-process
the RAW history here: extract track_ids from prior `[card:…]` /
`[cite:…]` markers, mint per-turn integer aliases for each, and
inject them as a `PRIOR-TURN TRACKS` block into the worker's user
query. The LLM then picks a subset by integer ref (`[1,2,4]`) and
the existing `aliased_tools` wrapper dealiases back to real
track_ids — no chance for the model to invent catalog ids.
"""

from __future__ import annotations

from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import run_worker
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prior_refs import extract_prior_track_refs
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


_MAX_TURNS = 2


def _prior_refs_prompt(prior_track_ids: list[str], aliases) -> str:
    """Build the worker-prompt block that lists each prior-turn track
    by its freshly-minted integer alias. Mint here so the same alias
    map serves both the prompt rendering and the downstream
    `aliased_tools` dealias step."""
    refs: list[int] = []
    for tid in prior_track_ids:
        refs.append(aliases.alias_track(tid))
    lines = ["PRIOR-TURN TRACKS — these are the lectures the user is "
             "referring to. Use these refs in track-shaped tools:"]
    for ref, tid in zip(refs, prior_track_ids):
        lines.append(f"  [^{ref}] — {tid}")
    all_refs = ", ".join(str(r) for r in refs)
    lines.append(
        f'\nDeictic resolution: «этих» / «эти» / «these» / «those» / «them» '
        f'/ «all» → use ALL refs above ({all_refs}). '
        f'«first» / «первой» → lowest ref ({refs[0]}). '
        f'«last» / «последней» → highest ref ({refs[-1]}). '
        f'Specific positions — pick the matching refs by index.'
        f'\n\nIMPORTANT: when the user refers deictically to "those/these/etc" '
        f'lectures, use ONLY the PRIOR-TURN refs above. IGNORE any track '
        f'refs in the research notes section — those came from a fresh '
        f'search that the user is NOT pointing at.'
        f'\n\nNEVER pick a ref outside {all_refs}.'
    )
    return "\n".join(lines)


async def action_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    ctx = runtime.context
    history = state.get("history") or []

    # Extract prior-turn track refs BEFORE fold_history removes them.
    # Pre-mint aliases so the worker LLM only sees small integers it
    # can copy verbatim — invented integers outside the minted range
    # fail at the aliased_tools dealias step.
    prior_track_ids = extract_prior_track_refs(history)
    prior_refs_block = ""
    log.info(
        "action_worker_prior_refs",
        request_id=ctx.request_id,
        count=len(prior_track_ids),
        history_len=len(history),
    )
    if prior_track_ids:
        prior_refs_block = _prior_refs_prompt(prior_track_ids, ctx.aliases)

    extra_user_query = None
    if prior_refs_block:
        # Append to the user query so the LLM sees the available refs
        # alongside the actual user intent. The `run_react_loop` adds
        # this to the message stream as the user-role content.
        extra_user_query = (
            f"{state.get('user_query', '')}\n\n{prior_refs_block}"
        )

    result = await run_worker(
        state,
        runtime,
        role="action_worker",
        tools=ctx.action_tools,
        status_key="preparing_action",
        max_turns=_MAX_TURNS,
        extra_user_query=extra_user_query,
    )
    # Append, don't replace — research_worker's results stay in state
    # so the synthesizer can cite both the tracks AND the action.
    return {"tool_results": result.tool_results}
