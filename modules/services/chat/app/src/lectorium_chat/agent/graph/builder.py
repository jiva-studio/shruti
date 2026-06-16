"""Build the compiled chat StateGraph.

One factory function; called once at app startup. The compiled graph
is reused for every chat turn — node fns are async and stateless, all
per-turn data flows via `state` and `context` (TurnContext).

Topology:

                       START
                         │
                         ▼
                      router ──── direct_chat / unknown ─────┐
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

`synthesis_planner` only sits in the research_worker → synthesizer
arm because that's the only path that produces prose-grounding notes;
catalog/action/help workers go straight to the synthesizer.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph
from langgraph.pregel import Pregel

from lectorium_chat.agent.graph.conditional import (
    route_after_action,
    route_after_catalog,
    route_after_research,
    route_after_router,
)
from lectorium_chat.agent.graph.nodes import (
    action_worker_node,
    catalog_worker_node,
    help_worker_node,
    locate_worker_node,
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
    builder.add_node("action_worker", action_worker_node)
    builder.add_node("help_worker", help_worker_node)
    builder.add_node("show_verse_worker", show_verse_worker_node)
    builder.add_node("synthesis_planner", synthesis_planner_node)
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
            "action_worker": "action_worker",
            "help_worker": "help_worker",
            "show_verse_worker": "show_verse_worker",
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
    # help_worker emits a help blurb (not an action card) — straight to synth.
    builder.add_edge("help_worker", "synthesizer")
    # locate_worker emits concise location notes (chapter/verse address) —
    # straight to synthesizer; the outline-first synthesis_planner is for
    # essay-grounding research notes, not for a "where is it" pointer.
    builder.add_edge("locate_worker", "synthesizer")
    # show_verse_worker emits one verse note + card payload — straight to the
    # synthesizer for a short lead-in + follow-up chips; no planning needed.
    builder.add_edge("show_verse_worker", "synthesizer")
    builder.add_edge("synthesis_planner", "synthesizer")
    builder.add_edge("synthesizer", END)

    return builder.compile()
