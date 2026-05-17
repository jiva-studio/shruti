"""Tool registry for the agent loop.

Each `tools/foo.py` module exports a `TOOL_REGISTRY: list[dict]`. Each
entry has shape::

    {
        "name": "search_transcripts",
        "fn": search_transcripts,        # async callable
        "personalized": False,           # bind user_context via closure?
        "description": "...",            # LLM-visible
        "parameters": {...},             # JSON-Schema for arg validation
    }

This module walks the listed sub-modules, collects entries, and exposes:
- `TOOLS: dict[str, ToolFn]` — name → callable, used by the agent loop dispatcher
- `TOOL_SCHEMAS: list[dict]` — function-calling schemas passed to the LLM
- `build_personalized_tools(base, user_context)` — wraps personalize tools
  so each call has `user_context` injected via closure and any LLM-supplied
  `user_context` argument is silently dropped (defense against injection).

Adding a tool = create `tools/foo.py`, add an entry to its `TOOL_REGISTRY`,
add the module name to `_TOOL_MODULES` below. No edits to dispatch logic.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any, Awaitable, Callable

from lectorium_chat.domain import UserContext

ToolFn = Callable[..., Awaitable[Any]]


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


_register()


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
