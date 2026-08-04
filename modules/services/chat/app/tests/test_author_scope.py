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

from shruti_chat.application.author_scope import AuthorScope
from shruti_chat.domain.author_selection import AuthorSelection
from shruti_chat.domain.conversation_attributes import (
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
    import shruti_chat.agent.graph.nodes.find_tracks_worker as ftw

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
    from shruti_chat.agent.tools.chunks_find_similar import chunks_find_similar
    from shruti_chat.agent.turn_aliases import TurnAliasMap

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
    from shruti_chat.agent.tools.list_tracks import list_tracks
    from shruti_chat.domain.entities import Track

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
    from shruti_chat.agent.tools.user_history_search import user_history_search
    from shruti_chat.agent.turn_aliases import TurnAliasMap

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


async def test_a_pinned_lecture_is_still_a_lecture() -> None:
    """The gap a production probe found. Attribution refs arrive by a verse↔talk
    link rather than a search, so they bypass every eligible-id filter upstream
    — the question lookup, the memory pass and the topic refs all resolve through
    one funnel, and with the selection unapplied there an answer narrowed to a
    lecturer with no lectures still came back with eleven transcript citations.

    Books stay canon: only `ref_kind == "track"` is dropped."""
    from shruti_chat.research.models import AttributionRef
    from shruti_chat.research.pipeline import _fetch_refs

    asked: list[tuple[str, str]] = []

    class _Chunks:
        async def get_chunks_by_target(self, *, ref_kind, target_id, lang):
            asked.append((ref_kind, target_id))
            return []

        async def get_chunks_by_track_fragment(self, *args, **kwargs):
            # The path a `track` ref takes — a fragment lookup, NOT the
            # by-target one, which is why asserting on the latter alone proved
            # nothing (the first version of this test passed with the filter
            # removed).
            target = kwargs.get("target_id") or (args[0] if args else "")
            asked.append(("track", str(target)))
            return []

    refs = [
        AttributionRef(ref_kind="track", target_id="mine@0-1000"),
        AttributionRef(ref_kind="track", target_id="theirs@0-1000"),
        AttributionRef(ref_kind="verse", target_id="bg/2.13"),
        AttributionRef(ref_kind="document", target_id="doc_purport"),
    ]
    await _fetch_refs(
        refs,
        chunk_repo=_Chunks(),
        alias_map=None,
        lang="ru",
        canonical_score=0.9,
        author_scope=_scope(_selection(_OURS), _Catalog({_OURS: ["mine"]})),
    )
    # The other lecturer's pinned fragment never reached a lookup; the verse and
    # the purport did.
    assert ("track", "theirs@0-1000") not in asked
    assert ("verse", "bg/2.13") in asked
    assert ("document", "doc_purport") in asked


async def test_pinned_refs_ride_through_when_nothing_is_selected() -> None:
    from shruti_chat.research.models import AttributionRef
    from shruti_chat.research.pipeline import _fetch_refs

    asked: list[str] = []

    class _Chunks:
        async def get_chunks_by_target(self, *, ref_kind, target_id, lang):
            asked.append(target_id)
            return []

        async def get_window(self, *_a, **_k):
            return []

    await _fetch_refs(
        [AttributionRef(ref_kind="verse", target_id="bg/2.13")],
        chunk_repo=_Chunks(), alias_map=None, lang="ru", canonical_score=0.9,
        author_scope=_scope(AuthorSelection.unconstrained(), _Catalog({})),
    )
    # Asked at least once — twice here, because a ref with no chunks in the
    # answer language is retried language-agnostically. What matters is that it
    # was not dropped.
    assert asked and set(asked) == {"bg/2.13"}


# ── the link between the attribute and the scope ──────────────────────────
#
# Every test above hands the scope a selection directly, which is exactly how
# the filter reached production doing nothing at all: nine retrieval paths
# honoured a selection that no node ever applied. These pin the one call that
# joins them.


async def _settled(state: dict[str, Any], scope: AuthorScope) -> None:
    from shruti_chat.agent.graph.nodes.router import _settle_attributes

    class _Ctx:
        lang = "ru"
        lang_name = ""
        author_scope = scope

    await _settle_attributes(state, _Ctx(), None)


async def _apply_client_attribute(value: Any, catalog: Any) -> AuthorScope:
    scope = AuthorScope(catalog_repo=catalog, request_id="req")
    await _settled(
        {
            "history": [],
            "client_attributes": {
                LECTURE_AUTHORS: {"value": value, "explicit": True},
            },
        },
        scope,
    )
    return scope


async def test_the_router_applies_the_selection_it_settled() -> None:
    catalog = _Catalog({_OURS: ["t-ours"]})
    scope = await _apply_client_attribute(_OURS, catalog)
    assert scope.selection.constrained
    assert scope.selection.ids == (_OURS,)
    assert await scope.track_ids() == ["t-ours"]


async def test_choosing_everyone_lifts_the_narrowing_downstream() -> None:
    catalog = _Catalog({_OURS: ["t-ours"]})
    scope = await _apply_client_attribute(ALL, catalog)
    assert not scope.selection.constrained
    assert await scope.track_ids() is None


async def test_a_turn_that_chose_nobody_leaves_nothing_in_force() -> None:
    # The scope outlives no turn, but the object is created before the router
    # runs — so "no attribute" has to actively mean "no constraint", not
    # "whatever was there before".
    catalog = _Catalog({_OURS: ["t-ours"]})
    scope = AuthorScope(catalog_repo=catalog, request_id="req")
    scope.apply(_selection(_OURS))
    await _settled({"history": [], "client_attributes": None}, scope)
    assert not scope.selection.constrained
    assert await scope.track_ids() is None


async def test_the_planner_hands_the_scope_to_its_own_top_up(monkeypatch) -> None:
    """Stage 2 of the planner runs a FRESH lecture search of its own.

    It happens after retrieval is over and outside the pipeline that threads the
    scope, so it has to be handed the selection explicitly. Production proved
    what happens otherwise: the fanout honoured a selection whose lecturer has no
    lectures — zero lecture candidates in either round — and the answer still
    arrived with 29 transcript citations from two other teachers, topped up here.
    """
    from dataclasses import dataclass, field as dc_field

    from shruti_chat.agent.graph.nodes import synthesis_planner as planner_mod
    from shruti_chat.research.models import Outline, Thesis

    seen: dict[str, Any] = {}

    async def _spy(*args, **kwargs):
        seen.update(kwargs)
        return kwargs["_augmented"] if "_augmented" in kwargs else (args[0], [])

    monkeypatch.setattr(planner_mod, "augment_thin_theses", _spy)

    class _LLM:
        async def structured_output(self, *_a, **_k):
            return Outline(theses=[Thesis(thesis="t1", supporting_notes=[1])])

        async def text_completion(self, *_a, **_k):
            return ""

    @dataclass
    class _Ctx:
        llm: Any = None
        request_id: str = "req"
        langfuse_trace_id: str = ""
        embedder: Any = None
        chunk_repo: Any = None
        catalog_repo: Any = None
        aliases: Any = None
        reranker: Any = None
        lang_name: str = ""
        author_scope: Any = None

    @dataclass
    class _Runtime:
        context: _Ctx = dc_field(default_factory=_Ctx)

    scope = _scope(_selection(_OURS), _Catalog({_OURS: ["t-ours"]}))
    await planner_mod.synthesis_planner_node(
        {
            "user_query": "как развить смирение", "lang": "ru",
            "tool_results": [{"type": "lecture", "text": "x", "score": 0.7, "meta": {}}],
        },
        _Runtime(context=_Ctx(llm=_LLM(), author_scope=scope)),
    )

    assert seen.get("author_scope") is scope


# ── the author THIS message named ─────────────────────────────────────────
#
# The seam that shipped broken for everyone: the router extracts a speaker as a
# NAME, the research path read `router_args["author_id"]` — a key the router never
# writes — so no per-turn author ever narrowed anything. It was "tested":
# `test_router_args_propagated_to_fanout` hands the pipeline an `author_id` of its
# own and asserts it arrives. Testing a seam from the middle proves both halves
# exist, not that they meet.


class _Dict:
    """Catalog dictionary holding one author, in two locales like the real one —
    a single-locale fake cannot match a name typed in the other script."""

    async def resolve(self, kind, text, *, lang, limit):
        from types import SimpleNamespace

        return [
            SimpleNamespace(id=_OURS, full_name="A. C. Bhaktivedanta Swami Prabhupada"),
            SimpleNamespace(id=_OURS, full_name="А. Ч. Бхактиведанта Свами Прабхупада"),
        ]

    async def filter_track_ids(self, *, author_ids=None, **_kw):
        return ["t-ours"] if author_ids else None


class _MyLibrary:
    def __init__(self, names: list[str]) -> None:
        self._names = names

    async def get_own_author_names(self, _user_id):
        return list(self._names)


async def _turn_author_applied(
    *, asked: str, dictionary=None, library=None, sticky: bool = False,
    user_id: str = "u-1",
) -> AuthorScope:
    from shruti_chat.agent.graph.nodes.router import _turn_author

    scope = AuthorScope(
        catalog_repo=dictionary or _Dict(),
        private_repo=library or _MyLibrary([]),
        user_id=user_id,
        request_id="req",
    )
    if sticky:
        scope.apply(_selection("author_chosen_before"))

    class _Ctx:
        catalog_repo = dictionary or _Dict()
        chunk_repo = library or _MyLibrary([])
        author_scope = scope
        request_id = "req"

    _Ctx.user_id = user_id
    await _turn_author({"extracted_args": {"author": asked}}, _Ctx(), {})
    return scope


async def test_a_named_corpus_author_narrows_this_turn() -> None:
    scope = await _turn_author_applied(asked="Прабхупада")
    # The name the router extracted, resolved and in force for retrieval.
    assert scope.selection.constrained
    assert scope.selection.ids == (_OURS,)
    assert await scope.track_ids() == ["t-ours"]


async def test_a_teacher_only_my_library_knows_narrows_it_too() -> None:
    scope = await _turn_author_applied(
        asked="Rohini suta Prabhu",
        library=_MyLibrary(["Rohini Suta Prabhu", "H.G. Rohini Suta Prabhu"]),
    )
    assert scope.selection.constrained
    assert set(scope.selection.raw_names) == {
        "Rohini Suta Prabhu", "H.G. Rohini Suta Prabhu",
    }
    # And the corpus has no such author, so its lecture lane must go empty rather
    # than answer from whoever it likes best — which is how production ended up
    # attributing other lecturers' words to him.
    assert await scope.track_ids() == []


async def test_a_name_nobody_has_constrains_nothing() -> None:
    scope = await _turn_author_applied(asked="Some Visiting Speaker")
    assert not scope.selection.constrained
    assert await scope.track_ids() is None


async def test_a_standing_choice_is_not_widened_by_a_mention() -> None:
    scope = await _turn_author_applied(
        asked="Прабхупада", sticky=True,
    )
    assert scope.selection.ids == ("author_chosen_before",)


async def test_no_author_in_the_message_leaves_the_scope_alone() -> None:
    scope = await _turn_author_applied(asked="")
    assert not scope.selection.constrained


async def test_an_anonymous_turn_cannot_search_a_library() -> None:
    scope = await _turn_author_applied(
        asked="Rohini suta Prabhu",
        library=_MyLibrary(["Rohini Suta Prabhu"]),
        user_id="",
    )
    assert not scope.selection.constrained


async def test_the_router_calls_it(monkeypatch) -> None:
    """The wire itself: `router_node` must invoke it. Everything above passes with
    the call missing — that is exactly how the last two of these shipped."""
    from shruti_chat.agent.graph.nodes import router as router_mod

    called: list[str] = []

    async def _spy(state, ctx, settled):
        called.append((state.get("extracted_args") or {}).get("author", ""))

    monkeypatch.setattr(router_mod, "_turn_author", _spy)
    src = __import__("inspect").getsource(router_mod.router_node)
    assert "_turn_author(" in src, "router_node must apply the message's author"
