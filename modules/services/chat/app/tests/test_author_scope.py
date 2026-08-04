"""The author selection narrows every lecture retrieval, and only lectures.

Eight paths retrieve lectures, and a filter honoured by seven of them is worse
than none: it reads as "the corpus has nothing by them" while another path
quietly serves someone else. So the shapes are pinned here — resolve-once,
intersect-with-my-own-list, don't-trust-the-model's-argument, and leave the
books alone.

Two things are deliberately NOT symmetric:

- a person's OWN added lectures are narrowed only by a selection they STATED, so
  a default can never hide their library;
- an unattributable lecture is excluded under a constraint, because a lecture we
  cannot attribute is not known to be by the person who was asked for.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.application.author_scope import AuthorScope
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import (
    ALL,
    LECTURE_AUTHORS,
    Attribute,
)


_OURS = "author_ours"
_OTHER = "author_other"


class _Catalog:
    """Only `filter_track_ids` matters here; it answers by author like the real
    one, and counts calls so "resolved once" is a fact and not a hope."""

    def __init__(self, by_author: dict[str, list[str]]) -> None:
        self._by_author = by_author
        self.calls = 0

    async def filter_track_ids(self, *, author_ids=None, **_kw):
        self.calls += 1
        if not author_ids:
            return None
        out: list[str] = []
        for a in author_ids:
            out.extend(self._by_author.get(a, []))
        return out


def _scope(selection: AuthorSelection, catalog: Any) -> AuthorScope:
    scope = AuthorScope(catalog_repo=catalog, request_id="req")
    scope.apply(selection)
    return scope


def _selection(*ids: str, explicit: bool = True) -> AuthorSelection:
    return AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(
            value=list(ids), label="Выбранные", explicit=explicit,
        ),
    })


# ── reading the selection off the attribute ───────────────────────────────


def test_no_attribute_means_everyone() -> None:
    # The default. A filter exists only because someone asked for one.
    sel = AuthorSelection.from_attributes({})
    assert not sel.constrained
    assert sel.allows(_OTHER) and sel.allows(None)


def test_all_lifts_a_filter() -> None:
    # «ищи у всех» has to be a VALUE: the merge cannot remove an attribute, so
    # an absence could never travel back to say "stop narrowing".
    sel = AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=[ALL], explicit=True),
    })
    assert not sel.constrained


def test_all_beside_names_is_still_everyone() -> None:
    # "everyone plus these two" is everyone; reading it as a narrowing would
    # silently drop the wider half of what was asked.
    sel = AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=[ALL, _OURS], explicit=True),
    })
    assert not sel.constrained


def test_named_authors_constrain() -> None:
    sel = _selection(_OURS)
    assert sel.constrained
    assert sel.allows(_OURS)
    assert not sel.allows(_OTHER)


def test_an_unattributable_lecture_is_not_theirs() -> None:
    assert not _selection(_OURS).allows(None)
    assert not _selection(_OURS).allows("")


def test_an_unsettled_attribute_constrains_nothing() -> None:
    sel = AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=[], explicit=True),
    })
    assert not sel.constrained


# ── resolving to track ids ────────────────────────────────────────────────


async def test_the_selection_resolves_once_per_turn() -> None:
    # Eight sites ask; the catalog is asked once. Otherwise every turn pays
    # eight round-trips for one answer that cannot change mid-turn.
    catalog = _Catalog({_OURS: ["t1", "t2"]})
    scope = _scope(_selection(_OURS), catalog)

    assert await scope.track_ids() == ["t1", "t2"]
    assert await scope.track_ids() == ["t1", "t2"]
    await scope.narrow(["t1", "t9"])
    assert catalog.calls == 1


async def test_no_constraint_asks_the_catalog_nothing() -> None:
    catalog = _Catalog({_OURS: ["t1"]})
    scope = _scope(AuthorSelection.unconstrained(), catalog)
    assert await scope.track_ids() is None
    assert catalog.calls == 0


async def test_a_catalog_failure_fails_open() -> None:
    """A filter that quietly matches nothing looks exactly like "the corpus has
    nothing on this" — the worst outcome available, so a broken lookup lifts the
    constraint instead of emptying every answer."""

    class _Broken:
        async def filter_track_ids(self, **_kw):
            raise RuntimeError("catalog down")

    scope = _scope(_selection(_OURS), _Broken())
    assert await scope.track_ids() is None
    assert await scope.narrow(["t1", "t2"]) == ["t1", "t2"]


async def test_an_empty_result_is_not_the_same_as_no_constraint() -> None:
    # The selected lecturers genuinely have nothing: the caller must see [] and
    # stop, not None and search everything.
    catalog = _Catalog({})
    scope = _scope(_selection(_OURS), catalog)
    assert await scope.track_ids() == []
    assert await scope.narrow(["t1"]) == []


# ── intersecting with a call site's own list ──────────────────────────────


async def test_narrow_keeps_the_callers_order() -> None:
    # Some sites rank by their own list order, so the intersection must not
    # reorder it into the catalog's.
    catalog = _Catalog({_OURS: ["t3", "t1", "t2"]})
    scope = _scope(_selection(_OURS), catalog)
    assert await scope.narrow(["t2", "t1"]) == ["t2", "t1"]


async def test_narrow_drops_what_the_selection_excludes() -> None:
    catalog = _Catalog({_OURS: ["t1"]})
    scope = _scope(_selection(_OURS), catalog)
    assert await scope.narrow(["t1", "t2"]) == ["t1"]


async def test_narrow_of_nothing_is_the_selection_itself() -> None:
    # A site with no list of its own (a plain semantic search) gets the
    # selection as its eligible set.
    catalog = _Catalog({_OURS: ["t1", "t2"]})
    scope = _scope(_selection(_OURS), catalog)
    assert await scope.narrow(None) == ["t1", "t2"]


async def test_several_lecturers_are_a_union() -> None:
    catalog = _Catalog({_OURS: ["t1"], _OTHER: ["t2"]})
    scope = _scope(_selection(_OURS, _OTHER), catalog)
    assert sorted(await scope.track_ids() or []) == ["t1", "t2"]


@pytest.mark.parametrize("explicit", [True, False])
async def test_explicitness_travels_with_the_selection(explicit: bool) -> None:
    # It decides one thing downstream: whether the private lane is narrowed too.
    catalog = _Catalog({_OURS: ["t1"]})
    scope = _scope(_selection(_OURS, explicit=explicit), catalog)
    assert scope.selection.explicit is explicit


# ── the call sites: the filter must not be bypassable ─────────────────────


async def test_the_lecture_card_search_narrows_and_never_relaxes_it() -> None:
    """The ladder gives up the author a QUESTION named; it must not give up the
    one a SETTING named, or a person who limited the answer to one lecturer is
    handed another one's lecture — the defect we removed from the language
    ladder for the same reason."""
    import lectorium_chat.agent.graph.nodes.find_tracks_worker as ftw

    searched: list[Any] = []

    class _Chunks:
        async def search_by_embedding(self, _emb, *, eligible_track_ids, lang, top_k):
            searched.append(eligible_track_ids)
            return []

    class _Cat(_Catalog):
        async def filter_track_ids(self, **kwargs):
            # The ladder's own filters matched everything.
            self.calls += 1
            return None

    catalog = _Cat({_OURS: ["t1"]})
    scope = _scope(_selection(_OURS), _Catalog({_OURS: ["t1"]}))

    class _Ctx:
        catalog_repo = catalog
        chunk_repo = _Chunks()
        author_scope = scope
        lang = "ru"

    await ftw._search(_Ctx(), [0.1], {"author_ids": None}, lang="ru")
    # Every rung is searched inside the selection, even the one that dropped
    # every other constraint.
    assert searched == [["t1"]]


async def test_similar_lectures_stay_inside_the_selection() -> None:
    # "more like this fragment" is the one lane that starts from a citation
    # rather than a query, so it has no eligible list of its own to intersect.
    from lectorium_chat.agent.tools.chunks_find_similar import chunks_find_similar
    from lectorium_chat.agent.turn_aliases import TurnAliasMap

    seen: list[Any] = []

    class _Chunks:
        async def get_anchor_texts(self, *_a, **_k):
            return ["anchor"]

        async def search_by_embedding(self, _emb, *, eligible_track_ids, **_k):
            seen.append(eligible_track_ids)
            return []

    class _Emb:
        async def embed_query(self, _q):
            return [0.1]

    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("t9", 0, 1000)
    await chunks_find_similar(
        ref,
        chunk_repo=_Chunks(), embedder=_Emb(), alias_map=aliases,
        author_scope=_scope(_selection(_OURS), _Catalog({_OURS: ["t1"]})),
    )
    assert seen == [["t1"]]


async def test_a_listing_ignores_the_models_author_argument() -> None:
    """`list_tracks` takes an author FROM THE MODEL. A worker that names nobody
    would otherwise list every lecturer's tracks — so the selection, not the
    argument, is the authority."""
    from lectorium_chat.agent.tools.list_tracks import list_tracks
    from lectorium_chat.domain.entities import Track

    def _track(tid: str, author: str) -> Track:
        return Track(
            id=tid, title=tid, lang="ru", date="1976-01-01",
            author_id=author, author_name=author, location_id=None,
            location_name=None, tag_ids=(), tag_names=(), duration_ms=None,
            references=(),
        )

    class _Cat:
        async def list_tracks(self, **_kw):
            return [_track("mine", _OURS), _track("theirs", _OTHER)]

    rows = await list_tracks(
        author_id=None,  # the model named nobody
        catalog_repo=_Cat(),
        author_scope=_scope(_selection(_OURS), _Catalog({_OURS: ["mine"]})),
    )
    assert [r["track_id"] for r in rows] == ["mine"]


async def test_history_search_narrows_what_the_user_listened_to() -> None:
    # These are PUBLIC tracks the user happens to have played, so the catalog
    # knows their authors and the intersection is exact.
    from lectorium_chat.agent.tools.user_history_search import user_history_search
    from lectorium_chat.agent.turn_aliases import TurnAliasMap

    seen: list[Any] = []

    class _Chunks:
        async def search_by_embedding(self, _emb, *, eligible_track_ids, **_k):
            seen.append(eligible_track_ids)
            return []

    class _Emb:
        async def embed_query(self, _q):
            return [0.1]

    class _Ctx:
        recent_tracks = (
            type("T", (), {"track_id": "mine"})(),
            type("T", (), {"track_id": "theirs"})(),
        )

    await user_history_search(
        "карма", user_context=_Ctx(), chunk_repo=_Chunks(), embedder=_Emb(),
        alias_map=TurnAliasMap(), lang="ru",
        author_scope=_scope(_selection(_OURS), _Catalog({_OURS: ["mine"]})),
    )
    assert seen == [["mine"]]
