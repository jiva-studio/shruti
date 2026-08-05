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

from shruti_chat.domain.routing import Intent
from shruti_chat.research.models import Outline, ResearchNote


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
    # Conversation attributes as the CLIENT aggregated them (see
    # `domain/conversation_attributes.py`). The client folds its full local
    # history, which the request can't carry — `messages` is capped at 20 — so
    # this is what makes a settled attribute outlive a long dialogue. Absent on
    # a client that doesn't aggregate; the router then folds the messages.
    client_attributes: dict[str, Any]
    request_id: str
    # Subscription tier ("pro" | "free" | "anon"), from the verified JWT
    # claim. Read by the add_to_library_worker to PRO-gate the capability.
    tier: str

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
    # The enum, not `str`: `route_after_router` branches on this value, and a
    # typo or a retired name would otherwise fall silently into the default
    # research arm. (The dict is still a plain dict at runtime — TypedDict keys
    # are not enforced — but a checker now sees the mismatch.)
    intent: Intent
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

    # ── Out-of-corpus fallback (memory-pass) ──────────────────────────
    # `corpus_insufficient` is set by `synthesis_planner_node` ONLY when the
    # corpus genuinely had nothing relevant (empty tool_results, or the planner
    # rejected every note → Outline(theses=[])) — never on planner degradation
    # (disabled / no-LLM / build failure). `route_after_planner` reads it to
    # branch into `corpus_fallback`.
    corpus_insufficient: bool
    # Set by `find_tracks_worker` when a "find lectures" query matched nothing in
    # the corpus and it wasn't a bare scripture ref / date probe. `route_after_
    # find_tracks` reads it to route into `add_to_library_worker` (web discovery
    # of candidate lectures to add), which reads the same `user_query`.
    web_fallback: bool
    # Set by `corpus_fallback_node` once the memory-pass succeeds. The
    # synthesizer reads `fallback_mode` to swap the `grounding` section for
    # `fallback` (disclaimer + faithful draft + opportunistic citations, never
    # refuse) and renders `fallback_answer` as the answer substance.
    fallback_mode: bool
    # "memory" → answered from general knowledge (disclaimer + draft).
    # "out_of_scope" → question is unrelated to the assistant's domain
    # (cooking, sports…); the synthesizer politely declines instead.
    fallback_kind: str
    # Memory-pass self-assessed certainty ("high"/"medium"/"low") — used only
    # to calibrate how much the reply hedges, never as a truth gate.
    fallback_confidence: str | None
    fallback_answer: str | None
    # Localized «не нашёл в корпусе, отвечаю по памяти» line. Painted verbatim by
    # the synthesizer BEFORE the prose (the model can't be trusted to always
    # reproduce a mandatory disclaimer), so it's guaranteed present + in-language.
    fallback_disclaimer: str | None
    # Notes from the fallback re-search (corpus probes derived from the draft
    # answer, score-floored). Kept SEPARATE from `tool_results` — that field's
    # append-reducer still holds the rejected junk pool from research_worker,
    # which the fallback synthesizer must NOT cite. The synthesizer reads these
    # in place of `tool_results` when `fallback_mode` is set.
    fallback_notes: list[ResearchNote]
