"""AuthorScope — the turn's author selection, resolved to track ids once.

Every retrieval path has to honour the same selection, and there are eight of
them: the research fan-out, the per-thesis top-up, `chunks_search`,
`chunks_find_similar`, `user_history_search`, the lecture-card search,
`list_tracks`, and the recommender. Asking each to resolve the selection itself
would mean eight catalog round-trips per turn and one forgotten site away from a
filter that silently does nothing.

So it resolves ONCE, lazily, and every site intersects with the result.

Lazily because the selection is not known when the turn is built: it is settled
in the router, from this message plus what the conversation already knew. The
object is created empty, shared by reference with the context and the tool
wrappers, and filled in by the router — the same trick `emitted_action_ids`
uses to be visible to both the workers and the marker expander.

Enforced in code, never asked of the model: the workers call tools directly, so
a prompt rule would be advice. The scope reaches the tools as a keyword the LLM
schema does not expose, like `book_id` before it.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.domain.author_selection import AuthorSelection
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


class AuthorScope:
    """The selection in force, and the track ids it allows.

    `track_ids()` returns None for "no constraint" — the same sentinel
    `CatalogRepository.filter_track_ids` uses, so a caller that already handles
    None needs no new branch.
    """

    def __init__(
        self,
        *,
        catalog_repo: Any | None = None,
        request_id: str | None = None,
    ) -> None:
        self._catalog_repo = catalog_repo
        self._request_id = request_id
        self._selection = AuthorSelection.unconstrained()
        self._resolved: list[str] | None = None
        self._done = False

    @property
    def selection(self) -> AuthorSelection:
        return self._selection

    def apply(self, selection: AuthorSelection) -> None:
        """Set the selection for the rest of the turn (called by the router)."""
        self._selection = selection
        self._resolved = None
        self._done = False

    async def track_ids(self) -> list[str] | None:
        """Track ids the selection allows, or None when nothing is constrained.

        An empty LIST is a real answer — the selected lecturers have nothing in
        the corpus — and callers must not confuse it with None.
        """
        if not self._selection.constrained or self._catalog_repo is None:
            return None
        if self._done:
            return self._resolved
        try:
            ids = await self._catalog_repo.filter_track_ids(
                author_ids=list(self._selection.ids),
                source_id=None,
                location_id=None,
                tag_ids=None,
                date_from=None,
                date_to=None,
            )
        except Exception as exc:  # noqa: BLE001
            # Fail OPEN: a catalog hiccup must not silently empty every answer.
            # A filter that quietly matches nothing is the worst outcome here —
            # it looks exactly like "the corpus has nothing on this".
            log.warning(
                "author_scope_resolve_failed",
                request_id=self._request_id, error=str(exc),
            )
            ids = None
        self._resolved = list(ids) if ids is not None else None
        self._done = True
        return self._resolved

    async def narrow(self, eligible: list[str] | None) -> list[str] | None:
        """Intersect a call site's own eligible ids with the selection.

        Order-preserving on the caller's list, because some sites rank by it.
        None from either side means "that side constrains nothing".
        """
        scope = await self.track_ids()
        if scope is None:
            return eligible
        if eligible is None:
            return scope
        allowed = set(scope)
        return [tid for tid in eligible if tid in allowed]
