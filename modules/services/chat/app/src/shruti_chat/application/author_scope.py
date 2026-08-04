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
(`narrow_owned`): uploads are not in the catalog, so they are matched by the
speaker name the ingest heard.

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

from shruti_chat.application.author_lookup import resolve_author
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
        facts_repo: Any | None = None,
        request_id: str | None = None,
    ) -> None:
        self._catalog_repo = catalog_repo
        # Reads what the ingest heard about privately added tracks — the chunk
        # repository, which already owns the private lane's tables.
        self._facts_repo = facts_repo
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
        answers from the catalog — would empty this lane wholesale and hide their
        library behind a filter that was never about them. What they have instead
        is what the ingest heard: a free-text speaker name per track.

        So the question asked here is the same one the lecture cards ask of a
        typed name — does this name denote the chosen author? — resolved through
        the shared lookup, across locales, so «Прабхупада» on an upload matches
        the catalog's "A. C. Bhaktivedanta Swami Prabhupada".

        Only an explicit selection reaches this lane at all: a default must never
        hide someone's own library. An upload with no recorded speaker is dropped
        under a constraint, for the same reason an unattributable corpus lecture
        is — we cannot claim it is by the person who was asked for.
        """
        if not owned:
            return owned
        if not self._selection.constrained or not self._selection.explicit:
            return owned
        if self._facts_repo is None or self._catalog_repo is None:
            # Nothing to decide with. Fail open, like every other unknown here.
            return owned
        try:
            by_track = await self._facts_repo.get_track_authors_raw(list(owned))
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "author_scope_owned_facts_failed",
                request_id=self._request_id, error=str(exc),
            )
            return owned

        allowed_names: dict[str, bool] = {}
        kept: list[str] = []
        for track_id in owned:
            name = (by_track.get(track_id) or "").strip()
            if not name:
                continue
            if name not in allowed_names:
                hit = await resolve_author(self._catalog_repo, name)
                allowed_names[name] = bool(
                    hit is not None and self._selection.allows(hit.id)
                )
            if allowed_names[name]:
                kept.append(track_id)
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
