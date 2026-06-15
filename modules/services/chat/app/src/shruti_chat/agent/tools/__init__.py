"""Tool registry for the agent loop.

Each `tools/*.py` module calls `register_tool(ToolDef(...))` at import
time. This package's `__init__` imports each module explicitly to
trigger those side-effect registrations, then exposes:

- `TOOLS: dict[str, ToolFn]` — name → callable, used by the agent loop
  dispatcher. After `bind_repositories()` runs in lifespan, each entry
  is a `functools.partial` with the appropriate adapters threaded in.
- `TOOL_SCHEMAS: list[dict]` — function-calling schemas passed to the LLM.
- `EMITS_EVENTS: frozenset[str]` — tool names that accept a `yield_event`
  callable; the loop creates one per dispatch.
- `bind_repositories(...)` — wire the infrastructure adapters into the
  tool callables (called once in `main.py:lifespan`).
- `build_personalized_tools(base, user_context)` — per-turn wrapper that
  binds `user_context` into personalize tools via closure.

Adding a tool: create `tools/<name>.py` with a `register_tool(...)`
call, then add a `from shruti_chat.agent.tools import <name>` line
to the side-effect-imports section below. There is no string list to
keep in sync.
"""

from __future__ import annotations

from functools import partial
from typing import Any

from shruti_chat.agent.tools._registry import (
    ToolDef,
    ToolFn,
    all_tools,
    register_tool,
)
from shruti_chat.domain import UserContext
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort

# Side-effect imports — each module calls `register_tool(...)` at the
# bottom. Imports stay explicit so a missing one is a static error
# rather than a runtime "tool not found".
from shruti_chat.agent.tools import (  # noqa: F401 — side-effect imports
    chunks_find_similar,
    chunks_get_by_address,
    chunks_get_window,
    chunks_search,
    find_collections,
    help,
    list_tracks,
    outline,
    pdf,
    propose_hints,
    resolve,
    tracks,
    user_history_search,
    user_recommendations_get,
    user_tracks_list,
)


__all__ = [
    "TOOLS",
    "TOOL_SCHEMAS",
    "EMITS_EVENTS",
    "ToolDef",
    "ToolFn",
    "bind_repositories",
    "build_personalized_tools",
    "register_tool",
]


YieldEvent = Any  # kept as Any for backwards-compat with existing call-sites


def _build_schemas(defs: dict[str, ToolDef]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": d.name,
                "description": d.description,
                "parameters": d.parameters,
            },
        }
        for d in defs.values()
    ]


_DEFS: dict[str, ToolDef] = all_tools()

TOOLS: dict[str, ToolFn] = {name: d.fn for name, d in _DEFS.items()}
TOOL_SCHEMAS: list[dict] = _build_schemas(_DEFS)
EMITS_EVENTS: frozenset[str] = frozenset(
    name for name, d in _DEFS.items() if d.emits_events
)
_PERSONALIZED: frozenset[str] = frozenset(
    name for name, d in _DEFS.items() if d.personalized
)


def bind_repositories(
    *,
    chunk_repo: ChunkRepository,
    catalog_repo: CatalogRepository,
    embedder: EmbedderPort,
) -> None:
    """Inject infrastructure adapters into the registered tool callables.

    Tool modules register bare functions at import time. They declare
    repository parameters as keyword-only (e.g.
    `chunks_search(..., *, chunk_repo, catalog_repo, embedder)`), then the
    composition root calls this once at startup to replace each
    `TOOLS[name]` with a `functools.partial` that supplies the actual
    adapter.

    Phase 7 will replace this dispatch table with a single Repositories
    dataclass and explicit `register_tool` calls in lifespan.
    """
    bindings: dict[str, dict[str, Any]] = {
        "chunks_search": {
            "chunk_repo": chunk_repo,
            "catalog_repo": catalog_repo,
            "embedder": embedder,
        },
        "chunks_get_by_address":  {
            "chunk_repo": chunk_repo,
            "catalog_repo": catalog_repo,
        },
        "chunks_get_window":      {"chunk_repo": chunk_repo},
        "chunks_find_similar":    {"chunk_repo": chunk_repo, "embedder": embedder},
        "user_history_search":    {"chunk_repo": chunk_repo, "embedder": embedder},
        "user_recommendations_get": {"chunk_repo": chunk_repo},
        "user_tracks_list":       {"catalog_repo": catalog_repo},
        "track_get":             {"catalog_repo": catalog_repo},
        "tracks_list":           {"catalog_repo": catalog_repo},
        "collections_find":      {"catalog_repo": catalog_repo},
        "author_resolve":        {"catalog_repo": catalog_repo},
        "source_resolve":        {"catalog_repo": catalog_repo},
        "location_resolve":      {"catalog_repo": catalog_repo},
        "tag_resolve":           {"catalog_repo": catalog_repo},
        "track_outline_get":     {"catalog_repo": catalog_repo},
        "track_pdf_generate":    {"catalog_repo": catalog_repo},
    }
    for name, kwargs in bindings.items():
        fn = TOOLS.get(name)
        if fn is None:
            continue
        TOOLS[name] = partial(fn, **kwargs)


def build_personalized_tools(
    base: dict[str, ToolFn], user_context: UserContext | None,
) -> dict[str, ToolFn]:
    """Bind `user_context` into personalize tools via closure.

    Stateless tools pass through unchanged. Personalize tools get a
    wrapper that always supplies the server-side `user_context` and
    rejects any LLM-supplied one (the schema doesn't expose it, but a
    model might still invent the field).
    """
    out = dict(base)
    for name in _PERSONALIZED:
        fn = base.get(name)
        if fn is None:
            continue

        def _make(_fn: ToolFn) -> ToolFn:
            async def _wrapped(**kwargs: Any) -> Any:
                kwargs.pop("user_context", None)
                return await _fn(user_context=user_context, **kwargs)

            return _wrapped

        out[name] = _make(fn)
    return out
