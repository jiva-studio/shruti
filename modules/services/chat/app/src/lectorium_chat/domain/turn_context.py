"""TurnContext — per-turn injected services for the chat graph.

This object lives **alongside** the graph's state, not inside it. The
graph state (`agent/graph/state.py`) holds turn data that flows through
nodes (user_query, intent, tool_results); TurnContext holds **services**
that nodes consume but don't conceptually "produce" or "update":

- `aliases` — the per-turn `TurnAliasMap` shared between every node
  that mints (worker tools) or reads (synthesizer's marker expander)
- `expander` — the `MarkerExpander` instance owning the in-flight
  delta buffer for the current turn
- `emitted_verse_refs` — dedup tracker for `action.kind=verse` events;
  once a verse is emitted to the SSE writer it's NOT re-emitted on
  subsequent tool calls within the same turn
- `llm` — the `LLMPort` injected by the composition root; tests
  substitute `FakeLLM` here
- `*_tools` — pre-built tool subsets per worker role. Each subset
  has already gone through `build_personalized_tools` +
  `build_aliased_tools`, then sliced by name in
  `chat_turn.py:_subset(...)` to the per-worker bag. Nodes hand the
  bag to `application/research_turn.run_research_turn` — we run our
  own ReAct loop, not LangGraph's `create_react_agent`, so we can
  inject `yield_event` into emits_events tools.
- `request_id` — for log correlation; mirrored into structlog's
  context vars at turn entry

Why not in graph state: LangGraph treats state as immutable updates
merged via reducers — mutable objects (a Python dict you keep mutating,
a class with internal `_used: set`) break the diff machinery.
Context is for "injected per-run services", which is exactly what
these are. See `tests/spike/SPIKE_REPORT.md` Q#5 for the empirical
confirmation that mutations propagate across nodes via context.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.turn_aliases import TurnAliasMap


if TYPE_CHECKING:
    # Import-time avoidance: tool registry pulls in side-effect imports
    # of every tool module — heavy and not needed for type-checking.
    from lectorium_chat.agent.tools._registry import ToolFn
    from lectorium_chat.domain.ports.llm_provider import LLMPort

    ToolMap = dict[str, ToolFn]
else:
    ToolMap = dict


@dataclass
class TurnContext:
    """Per-turn injected services. Lifetime: one `graph.astream` call.

    The composition root (`application/chat_turn.py` wrapper) builds
    this fresh per request and discards it at turn end. Nodes never
    construct one themselves — they receive it via
    `Runtime[TurnContext].context`.
    """

    # ── Identity / correlation ─────────────────────────────────────────
    request_id: str = ""

    # ── Citation pipeline (mutable, shared by reference) ──────────────
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    expander: MarkerExpander | None = None
    emitted_verse_refs: set[int] = field(default_factory=set)

    # ── Injected services ──────────────────────────────────────────────
    # Optional fields are typed as `Any | None` at runtime to avoid
    # forcing every test that builds a TurnContext to provide a real
    # LLMPort / full toolset. Production composition root supplies them.
    llm: Any | None = None
    research_tools: ToolMap = field(default_factory=dict)
    catalog_tools: ToolMap = field(default_factory=dict)
    action_tools: ToolMap = field(default_factory=dict)
    help_tools: ToolMap = field(default_factory=dict)

    # ── SSE writer bridge ──────────────────────────────────────────────
    # When set, tools (via the as_langchain_tool yield_event closure)
    # and nodes (via direct call) push events through this callable.
    # The chat_turn.py wrapper hooks it into LangGraph's
    # `get_stream_writer` at composition time.
    writer: Callable[[str, dict[str, Any]], None] | None = None

    # ── Library DB path ─────────────────────────────────────────────────
    # Path to local library.db SQLite (for verse body lookups in the
    # research worker). Typed as Any to avoid pulling pathlib here when
    # most callers pass an Optional[Path].
    library_db_path: Any | None = None
