"""AuthorScope — the turn's author selection, resolved to track ids once.

Ten retrieval paths have to honour the same selection: the research fan-out, the
attribution refs, the planner's per-thesis top-up, `chunks_search`,
`chunks_find_similar`, `user_history_search`, the lecture-card search,
`list_tracks`, the recommender, and the private lane over someone's own uploads.
Asking each to resolve the selection itself would mean ten catalog round-trips per
turn and one forgotten site away from a filter that silently does nothing — which
is exactly what shipped twice before this object existed.

So it resolves ONCE, lazily, and every site intersects with the result. The
private lane is the one exception, and it asks a different question
(`narrow_owned`): uploads are not in the catalog, so they are matched on the
speaker stamped on their chunks when they were indexed.

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
        private_repo: Any | None = None,
        user_id: str = "",
        request_id: str | None = None,
    ) -> None:
        self._catalog_repo = catalog_repo
        # Answers "which of this person's own tracks are by the chosen
        # lecturers" — the chunk repository, which owns the private lane.
        self._private_repo = private_repo
        # Whose library the private lane may narrow. Empty for an anonymous turn,
        # which then has no private lane at all.
        self._user_id = user_id
        self._request_id = request_id
        self._selection = AuthorSelection.unconstrained()
        self._resolved: list[str] | None = None
        self._done = False
        # How many chunks the PRIVATE lane returned this turn. The honest note
        # cannot read this off the synthesizer's pool: their fragments reach the
        # answer by another route (the pool showed verse/commentary only while
        # four of their citations were printed), so the lane reports it directly.
        self._private_hits = 0

    @property
    def selection(self) -> AuthorSelection:
        return self._selection

    @property
    def private_hits(self) -> int:
        """Chunks the private lane returned this turn — evidence that their own
        recordings DID contribute, whatever the pool the synthesizer was handed
        looks like."""
        return self._private_hits

    def note_private_hits(self, n: int) -> None:
        self._private_hits += max(0, int(n))

    def apply(self, selection: AuthorSelection) -> None:
        """Set the selection for the rest of the turn (called by the router)."""
        self._selection = selection
        self._resolved = None
        self._done = False
        # Logged even when nothing is selected. A filter that narrows nothing and
        # a filter that was never applied produce the identical answer, so
        # without this line a production trace cannot tell them apart — which is
        # exactly the hour this feature cost.
        log.info(
            "author_scope_applied",
            request_id=self._request_id,
            constrained=selection.constrained,
            authors=len(selection.ids),
            explicit=selection.explicit,
        )

    async def track_ids(self) -> list[str] | None:
        """Track ids the selection allows, or None when nothing is constrained.

        An empty LIST is a real answer — the selected lecturers have nothing in
        the corpus — and callers must not confuse it with None.
        """
        if not self._selection.constrained or self._catalog_repo is None:
            return None
        if not self._selection.ids:
            # Constrained, but on a teacher the CORPUS does not have (a personal
            # library name). The catalog would read an empty author list as "no
            # filter" and hand back everything, so answer for it: no corpus
            # lecture qualifies.
            return []
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
        log.info(
            "author_scope_resolved",
            request_id=self._request_id,
            authors=len(self._selection.ids),
            # None = the catalog declined to constrain (a hiccup, failed open);
            # 0 = the selected lecturers genuinely have nothing in the corpus.
            tracks=None if self._resolved is None else len(self._resolved),
        )
        return self._resolved

    async def narrow_owned(self, owned: list[str] | None) -> list[str] | None:
        """Narrow a person's OWN added lectures to the chosen lecturers.

        Their uploads are not in the published catalog, so `track_ids()` — which
        answers from the catalog — says nothing about them. What they have
        instead is a speaker resolved when the track was indexed and stamped on
        its chunks, so this is one join on the same `author_id` column the public
        lane filters by; no per-turn matching of free-text names.

        The caller's list stays authoritative for ACCESS (it is the ACL); this
        only removes from it. Order-preserving, like `narrow`.

        Only an explicit selection narrows this lane: a default must never hide
        someone's own library. Every unknown fails open, for the same reason —
        hiding a library because a query failed is the worse error.
        """
        if not owned:
            return owned
        if not self._selection.constrained or not self._selection.explicit:
            return owned
        if self._private_repo is None or not self._user_id:
            return owned
        if not self._selection.ids and not self._selection.raw_names:
            return owned
        try:
            by_author = await self._private_repo.get_owned_track_ids_by_author(
                self._user_id,
                list(self._selection.ids),
                list(self._selection.raw_names),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "author_scope_owned_query_failed",
                request_id=self._request_id, error=str(exc),
            )
            return owned
        allowed = set(by_author)
        kept = [tid for tid in owned if tid in allowed]
        log.info(
            "author_scope_owned_narrowed",
            request_id=self._request_id, had=len(owned), kept=len(kept),
        )
        return kept

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
