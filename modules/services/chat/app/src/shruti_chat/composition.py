"""Composition root — assembles `AppDeps` from settings + concrete adapters.

`AppDeps` is the only place infrastructure objects live as long-lived
references; FastAPI routes pull them via `Depends(get_deps)`. Replacing
an adapter (e.g. for tests) means building an `AppDeps` instance with
fake repos and stuffing it into `app.state.deps`.
"""

from __future__ import annotations

from fastapi import Request

from shruti_chat.application.deps import AppDeps
from shruti_chat.domain.name_matching import NameConvention, NameMatcher
from shruti_chat.naming.vaishnava_naming import VAISHNAVA_NAMING

# The naming conventions of this corpus. A new language or tradition is a module
# under `naming/` added here.
NAME_CONVENTIONS: tuple[NameConvention, ...] = (VAISHNAVA_NAMING,)


def build_name_matcher() -> NameMatcher:
    return NameMatcher(NAME_CONVENTIONS)


def get_deps(request: Request) -> AppDeps:
    """FastAPI dependency: read the AppDeps stashed in `app.state` by
    the lifespan handler. Raises if lifespan hasn't run yet."""
    deps = getattr(request.app.state, "deps", None)
    if deps is None:
        raise RuntimeError(
            "AppDeps missing on app.state — lifespan not initialised"
        )
    return deps
