"""Tool registry for the agent loop.

Each `tools/foo.py` module exports a `TOOL_REGISTRY: list[dict]`. Each
entry has shape::

    {
        "name": "search_transcripts",
        "fn": search_transcripts,        # async callable
        "personalized": False,           # bind user_context via closure?
        "emits_events": False,           # receive yield_event callable?
        "description": "...",            # LLM-visible
        "parameters": {...},             # JSON-Schema for arg validation
    }

This module walks the listed sub-modules, collects entries, and exposes:
- `TOOLS: dict[str, ToolFn]` — name → callable, used by the agent loop dispatcher
- `TOOL_SCHEMAS: list[dict]` — function-calling schemas passed to the LLM
- `EMITS_EVENTS: frozenset[str]` — tool names that accept a `yield_event`
  callable. The loop creates one per dispatch and the tool may invoke it
  zero or more times to emit SSE side-events (action / outline payloads).
- `build_personalized_tools(base, user_context)` — wraps personalize tools
  so each call has `user_context` injected via closure and any LLM-supplied
  `user_context` argument is silently dropped (defense against injection).

Adding a tool = create `tools/foo.py`, add an entry to its `TOOL_REGISTRY`,
add the module name to `_TOOL_MODULES` below. No edits to dispatch logic.
"""

from __future__ import annotations

from functools import partial
from importlib import import_module
from typing import Any, Awaitable, Callable

from lectorium_chat.domain import UserContext
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.outline_cache import OutlineCache
from lectorium_chat.domain.ports.transcript_storage import TranscriptStorage

ToolFn = Callable[..., Awaitable[Any]]
YieldEvent = Callable[[str, dict[str, Any]], None]


_TOOL_MODULES = (
    "actions",
    "list_tracks",
    "outline",
    "personalize",
    "resolve",
    "search",
    "similar",
    "tracks",
    "window",
)


TOOLS: dict[str, ToolFn] = {}
TOOL_SCHEMAS: list[dict] = []
_PERSONALIZED: set[str] = set()
_EMITS_EVENTS: set[str] = set()


def _register() -> None:
    for mod_name in _TOOL_MODULES:
        mod = import_module(f"lectorium_chat.agent.tools.{mod_name}")
        registry = getattr(mod, "TOOL_REGISTRY", None)
        if registry is None:
            raise RuntimeError(
                f"tool module {mod_name!r} is missing TOOL_REGISTRY"
            )
        for entry in registry:
            name = entry["name"]
            if name in TOOLS:
                raise RuntimeError(f"duplicate tool registration: {name}")
            TOOLS[name] = entry["fn"]
            TOOL_SCHEMAS.append(
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": entry["description"],
                        "parameters": entry["parameters"],
                    },
                }
            )
            if entry.get("personalized"):
                _PERSONALIZED.add(name)
            if entry.get("emits_events"):
                _EMITS_EVENTS.add(name)


_register()


EMITS_EVENTS: frozenset[str] = frozenset(_EMITS_EVENTS)


def bind_repositories(
    *,
    chunk_repo: ChunkRepository,
    catalog_repo: CatalogRepository,
    transcript_storage: TranscriptStorage,
    outline_cache: OutlineCache,
) -> None:
    """Inject infrastructure adapters into the registered tool callables.

    Tool modules register bare functions at import time. They declare
    repository parameters as keyword-only (e.g.
    `search_transcripts(..., *, chunk_repo, catalog_repo)`), then the
    composition root calls this once at startup to replace each
    `TOOLS[name]` with a `functools.partial` that supplies the actual
    adapter.

    Grows phase-by-phase as more ports come online. Phase 7 will replace
    this dispatch table with a single Repositories dataclass and
    explicit `register_tool` calls in lifespan.
    """
    bindings: dict[str, dict[str, Any]] = {
        "search_transcripts":     {"chunk_repo": chunk_repo, "catalog_repo": catalog_repo},
        "get_transcript_window":  {"chunk_repo": chunk_repo},
        "get_track":              {"catalog_repo": catalog_repo},
        "list_tracks":            {"catalog_repo": catalog_repo},
        "resolve_author":         {"catalog_repo": catalog_repo},
        "resolve_source":         {"catalog_repo": catalog_repo},
        "resolve_location":       {"catalog_repo": catalog_repo},
        "resolve_tag":            {"catalog_repo": catalog_repo},
        "get_track_outline":      {
            "catalog_repo": catalog_repo,
            "transcript_storage": transcript_storage,
            "outline_cache": outline_cache,
        },
        "propose_playlist":       {"catalog_repo": catalog_repo},
    }
    for name, kwargs in bindings.items():
        fn = TOOLS.get(name)
        if fn is None:
            continue
        TOOLS[name] = partial(fn, **kwargs)


def build_personalized_tools(
    base: dict[str, ToolFn], user_context: UserContext | None
) -> dict[str, ToolFn]:
    """Bind `user_context` into personalize tools via closure.

    Stateless tools pass through unchanged. Personalize tools get a wrapper
    that always supplies the server-side `user_context` and rejects any
    LLM-supplied one (the schema doesn't expose it, but a model might still
    invent the field).
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
