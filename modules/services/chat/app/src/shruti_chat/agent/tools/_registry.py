"""Typed tool registry.

Each `tools/*.py` module calls `register_tool(ToolDef(...))` once at
import time. `agent/tools/__init__.py` imports the modules explicitly
(no dynamic `import_module` over a hard-coded list) and then builds
the loop-facing collections from `_REGISTRY`.

The dataclass replaces the previous `dict[str, Any]` payload — every
field is typed, and `register_tool` rejects duplicates eagerly so
mis-merges fail fast instead of silently shadowing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


ToolFn = Callable[..., Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class ToolDef:
    name: str
    fn: ToolFn
    description: str
    parameters: dict[str, Any]
    personalized: bool = False
    emits_events: bool = False


_REGISTRY: dict[str, ToolDef] = {}


def register_tool(defn: ToolDef) -> None:
    if defn.name in _REGISTRY:
        raise ValueError(f"duplicate tool registration: {defn.name}")
    _REGISTRY[defn.name] = defn


def all_tools() -> dict[str, ToolDef]:
    """Read-only view of the registry (defensive copy)."""
    return dict(_REGISTRY)
