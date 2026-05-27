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
  bag to `application/react_loop.run_react_loop` — we run our
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
from typing import TYPE_CHECKING, Any

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
    # Langfuse root-trace UUID. Bound at turn entry by
    # `application/chat_turn.run_chat_turn`; each graph node reads it
    # to build a `CallbackHandler(stateful_client=…, trace_id=…)` so
    # every LLM span in the turn anchors under the SAME Langfuse
    # trace (without that, LangChain creates a fresh trace per
    # callback and the per-turn view in the UI fragments). Empty
    # string when observability is disabled — node-level helpers
    # short-circuit on the empty value.
    langfuse_trace_id: str = ""

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

    # ── Library DB path ─────────────────────────────────────────────────
    # Path to local library.db SQLite (for verse body lookups in the
    # research worker). Typed as Any to avoid pulling pathlib here when
    # most callers pass an Optional[Path].
    library_db_path: Any | None = None

    # ── Research pipeline collaborators ─────────────────────────────────
    # New code-driven research path (research/pipeline.py:run_research)
    # calls these directly instead of going through tool wrappers. Older
    # workers (catalog/action/help) keep using research_tools / catalog_tools.
    chunk_repo: Any | None = None       # ChunkRepository
    catalog_repo: Any | None = None     # CatalogRepository
    embedder: Any | None = None         # EmbedderPort
    pool: Any | None = None             # asyncpg.Pool — for direct attribution lookup
    embed_model: str | None = None      # settings.embed_model — required for attribution lookup
    # Per-deployment embedding dimensionality. The attribution-lookup SQL
    # resolves a `attribution_emb_d{embed_dim}` table at query time
    # (migration 0030 split per-dim embeddings). Without this the lookup
    # has no way to find which physical table its vectors live in.
    embed_dim: int | None = None        # settings.embed_dim

    # ── KV cache (Stage 2) ──────────────────────────────────────────────
    # Tiered L1+L2 cache injected by the composition root. Used by
    # deterministic LLM calls (router, title, topic, attr_confirm,
    # caption) and hot DB queries (chunk search, get_window, get_track,
    # get_author_names) to skip repeat work. Optional so tests can leave
    # it None and exercise the un-cached path.
    kv_cache: Any | None = None         # KVCache

    # ── Speculative embedding (Stage 2.8.a) ─────────────────────────────
    # Kicked off in `chat_turn` in parallel with the router LLM call.
    # The research pipeline awaits this future instead of re-embedding;
    # non-research routes cancel it from the router node.
    embed_task: Any | None = None       # asyncio.Task[list[float]] | None
