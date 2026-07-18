"""Build the compiled chat StateGraph.

One factory function; called once at app startup. The compiled graph
is reused for every chat turn — node fns are async and stateless, all
per-turn data flows via `state` and `context` (TurnContext).

Topology:

                       START
                         │
                         ▼
                      router ──── direct_chat ──────────────┐
            (unknown / default → research_worker, see #39)   │
                         │                                    │
       ┌────────────┬────┴──────────┬──────────────┬───┐      │
       │            │               │              │   │      │
       ▼            ▼               ▼              ▼   ▼      │
   help_worker  catalog_worker  research_worker  action_worker (short)
       │            │               │                  │      │
       │            │       create_action ──► action_worker   │
       │            │               │                  │      │
       │            │       else ───► synthesis_planner       │
       │            │                  │               │      │
       └────────────┴──► synthesizer ◄─┴───────────────┴──────┘
                            │
                            ▼
                           END

The short path (router → action_worker) is taken when the action
doesn't need tracks (reminder / smart_library / pro) OR the user
has a track anchored in context (current_track_ref / focus_ref) —
see `conditional.route_after_router`.

`find_track` routes to `find_tracks_worker` (not shown in the diagram
above): a deterministic terminal that semantic-searches lectures, emits
each card + verbatim why-quote itself, and goes straight to END — no
synthesizer. The one exception is listening-history-by-time-window
(`history_ref`), which stays on `catalog_worker` (user_tracks_list).

`synthesis_planner` only sits in the research_worker → synthesizer
arm because that's the only path that produces prose-grounding notes;
catalog/action/help workers go straight to the synthesizer.

When the planner finds the corpus insufficient (empty retrieval or every
note rejected) it flags `corpus_insufficient`, and the planner→synthesizer
edge instead routes through `corpus_fallback` — the out-of-corpus
"memory-pass": answer from a large model's general knowledge, re-search the
corpus on probes derived from that answer, then let the synthesizer compose
a disclaimed, opportunistically-cited reply. `corpus_fallback` → synthesizer.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph
from langgraph.pregel import Pregel

from lectorium_chat.agent.graph.conditional import (
    route_after_action,
    route_after_catalog,
    route_after_planner,
    route_after_research,
    route_after_router,
)
from lectorium_chat.agent.graph.nodes import (
    action_worker_node,
    add_to_library_worker_node,
    catalog_worker_node,
    clarify_worker_node,
    corpus_fallback_node,
    find_tracks_worker_node,
    help_worker_node,
    locate_worker_node,
    recommend_worker_node,
    research_worker_node,
    router_node,
    show_verse_worker_node,
    synthesizer_node,
)
from lectorium_chat.agent.graph.nodes.action_responder import (
    action_responder_node,
)
from lectorium_chat.agent.graph.nodes.synthesis_planner import (
    synthesis_planner_node,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext


def build_chat_graph() -> Pregel:
    """Construct and compile the chat StateGraph.

    Returns a compiled `Pregel` (the runnable form). Callers invoke
    via `graph.astream(input, context=turn_ctx, stream_mode=[...])`.
    """
    builder: StateGraph = StateGraph(ChatState, context_schema=TurnContext)

    builder.add_node("router", router_node)
    builder.add_node("research_worker", research_worker_node)
    builder.add_node("locate_worker", locate_worker_node)
    builder.add_node("catalog_worker", catalog_worker_node)
    builder.add_node("find_tracks_worker", find_tracks_worker_node)
    builder.add_node("recommend_worker", recommend_worker_node)
    builder.add_node("action_worker", action_worker_node)
    builder.add_node("add_to_library_worker", add_to_library_worker_node)
    builder.add_node("help_worker", help_worker_node)
    builder.add_node("show_verse_worker", show_verse_worker_node)
    builder.add_node("clarify_worker", clarify_worker_node)
    builder.add_node("synthesis_planner", synthesis_planner_node)
    builder.add_node("corpus_fallback", corpus_fallback_node)
    builder.add_node("synthesizer", synthesizer_node)
    builder.add_node("action_responder", action_responder_node)

    builder.add_edge(START, "router")
    builder.add_conditional_edges(
        "router",
        route_after_router,
        {
            "research_worker": "research_worker",
            "locate_worker": "locate_worker",
            "catalog_worker": "catalog_worker",
            "find_tracks_worker": "find_tracks_worker",
            "recommend_worker": "recommend_worker",
            "action_worker": "action_worker",
            "add_to_library_worker": "add_to_library_worker",
            "help_worker": "help_worker",
            "show_verse_worker": "show_verse_worker",
            "clarify_worker": "clarify_worker",
            "synthesizer": "synthesizer",
        },
    )
    # research_worker forks: chain → action_worker, OR plan synthesis.
    # We route the "stay → synthesizer" branch through synthesis_planner
    # so the outline-first synth path runs over research notes. The
    # planner itself degrades to outline=None on empty notes / LLM
    # failure, and the synthesizer then falls back to free-form prose.
    builder.add_conditional_edges(
        "research_worker",
        route_after_research,
        {
            "action_worker": "action_worker",
            "synthesizer": "synthesis_planner",
        },
    )
    # catalog_worker forks just like research_worker: stay → synth,
    # OR chain into action_worker for catalog-hint create_action turns.
    # Catalog results are list-tile envelopes, NOT prose-grounding notes
    # — so we deliberately bypass synthesis_planner here. The synthesizer
    # already has list-question rules in response_shape.md for these.
    builder.add_conditional_edges(
        "catalog_worker",
        route_after_catalog,
        {
            "action_worker": "action_worker",
            "synthesizer": "synthesizer",
        },
    )
    # action_worker forks: a produced card → action_responder (deterministic,
    # emits just the marker — no LLM); nothing found → synthesizer, which
    # writes the localized «не нашёл …» message (the only part needing an LLM).
    builder.add_conditional_edges(
        "action_worker",
        route_after_action,
        {
            "action_responder": "action_responder",
            "synthesizer": "synthesizer",
        },
    )
    builder.add_edge("action_responder", END)
    # find_tracks_worker is a fully deterministic terminal: it retrieves
    # lectures, force-emits each card + verbatim why-quote, and writes the
    # global + per-lecture headers (the only LLM hop) itself — no synthesizer.
    builder.add_edge("find_tracks_worker", END)
    # add_to_library_worker is a deterministic terminal too: it PRO-gates,
    # searches providers, emits candidate cards, and publishes the top match
    # to the ingest broker itself — no synthesizer.
    builder.add_edge("add_to_library_worker", END)
    # clarify_worker is a deterministic terminal: it emits one localized
    # question for a deictic request we can't ground (no current lecture / no
    # listen-history) — no synthesizer.
    builder.add_edge("clarify_worker", END)
    # recommend_worker emits topic-affinity lecture cards (or a "listen first"
    # note) deterministically — straight to the synthesizer, which only phrases
    # the lead-in + follow-up chips. No synthesis_planner (these are list-tile
    # cards, not essay-grounding notes), same as catalog_worker.
    builder.add_edge("recommend_worker", "synthesizer")
    # help_worker emits a help blurb (not an action card) — straight to synth.
    builder.add_edge("help_worker", "synthesizer")
    # locate_worker emits concise location notes (chapter/verse address) —
    # straight to synthesizer; the outline-first synthesis_planner is for
    # essay-grounding research notes, not for a "where is it" pointer.
    builder.add_edge("locate_worker", "synthesizer")
    # show_verse_worker emits one verse note + card payload — straight to the
    # synthesizer for a short lead-in + follow-up chips; no planning needed.
    builder.add_edge("show_verse_worker", "synthesizer")
    # synthesis_planner forks: a corpus-insufficient turn (empty retrieval or
    # every note rejected) goes through corpus_fallback for the out-of-corpus
    # memory-pass; otherwise straight to the synthesizer. The fallback node
    # degrades to {} (no fallback_mode) on missing LLM / failure, so the
    # synthesizer still reaches its normal refusal in every failure mode.
    builder.add_conditional_edges(
        "synthesis_planner",
        route_after_planner,
        {
            "corpus_fallback": "corpus_fallback",
            "synthesizer": "synthesizer",
        },
    )
    builder.add_edge("corpus_fallback", "synthesizer")
    builder.add_edge("synthesizer", END)

    return builder.compile()
