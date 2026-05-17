"""Domain types shared between API surface, agent loop, and tools.

Lives outside `api/` so consumers don't form a cycle (`agent` → `api`).
"""

from lectorium_chat.domain.user_context import (
    FocusFragment,
    UserContext,
    UserContextTrack,
    UserNote,
)

__all__ = ["FocusFragment", "UserContext", "UserContextTrack", "UserNote"]
