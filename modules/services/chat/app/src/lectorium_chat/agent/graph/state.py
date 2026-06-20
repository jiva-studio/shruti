"""ChatState — the TypedDict that flows through the LangGraph nodes.

Holds turn data that conceptually "advances" as the graph runs:
- the user's query and language
- the router's decision and extracted args
- accumulated tool_results from worker(s)

Does NOT hold:
- aliases / expander / emitted_verse_refs / llm / tools — those are
  per-turn injected services, live in `agent.graph.turn_context.TurnContext`,
  passed via LangGraph's `context_schema`. See plan section 9.4.
- conversation history — that's input from the client per request,
  threaded into `history` once at graph entry; the worker's internal
  ReAct messages are kept local to `run_react_loop`.

Mutable state additions use simple reducers (overwrite or list-append).
We don't use LangChain's `add_messages` because workers don't
contribute to a shared messages list — synthesizer is the only node
that streams text, and it doesn't write to state.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from lectorium_chat.research.models import Outline


class ChatState(TypedDict, total=False):
    """The state passed between graph nodes.

    `total=False` because different nodes populate different subsets:
    router sets `intent` / `extracted_args`; workers append to
    `tool_results`; synthesizer doesn't write to state at all (it
    streams via the writer channel).
    """

    # ── Input (set once at graph entry, immutable through the run) ────
    history: list[dict[str, Any]]
    user_query: str
    lang: str
    request_id: str

    # ── User context anchors ───────────────────────────────────────────
    # Integer aliases pre-minted by chat_turn.py wrapper from the
    # request's UserContext. Workers' system prompts surface these so
    # the LLM can pass them straight into chunks_get_window /
    # chunks_find_similar without ever seeing raw track_ids.
    focus_ref: int | None
    focus_around_ms: int | None
    current_track_ref: int | None
    # Lightweight summary of UserContext for the worker's anchor block.
    # `now_iso` lets the LLM compute date windows for user_tracks_list;
    # `history_summary` is a short counts string so the LLM knows user_*
    # tools have data to work with.
    now_iso: str | None
    history_summary: str | None

    # ── Per-turn experimental config (POST /chat body.config) ─────────
    # Bool toggles minted from ChatTurnConfigDto.model_dump(). Empty
    # dict when the client sent no `config` — node reads should default
    # each key to its prod-path value (see `enable_planner` lookup in
    # `synthesis_planner_node`).
    config: dict[str, Any]

    # ── Router output ─────────────────────────────────────────────────
    intent: str               # one of domain.routing.Intent
    confidence: float
    extracted_args: dict[str, Any]

    # ── Worker output (appended in chain order; list-append reducer) ──
    tool_results: Annotated[list[dict[str, Any]], operator.add]

    # ── Synthesis planner output ──────────────────────────────────────
    # Three meaningful values:
    #   - absent / None       → planner skipped or failed → synthesizer
    #                           runs in free-form mode (legacy behaviour)
    #   - Outline(theses=[])  → planner rejected all notes → refusal path
    #   - Outline(theses=[…]) → synthesizer writes one paragraph per
    #                           thesis, citing only its supporting_notes
    #
    # When synthesis_planner streams the intro early (early-intro paint),
    # it strips `intro` from the Outline it writes here, so the synthesizer
    # renders an intro-less plan and never reproduces the intro.
    outline: Outline | None

    # ── Curator memory (background context) ───────────────────────────
    # A matched memory note, set by `research_worker_node`. Injected by the
    # synthesizer as NON-citable background context (shapes the prose, never
    # cited). None when no memory matched. The memory's refs are already folded
    # into `tool_results` as ordinary citable notes.
    memory_note: str | None
