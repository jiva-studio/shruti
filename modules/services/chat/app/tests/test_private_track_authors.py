"""A lecturer filter reaches someone's OWN uploads instead of hiding them.

Their tracks are not in the published catalog, so the catalog-derived track-id set
says nothing about them — and intersecting with it emptied the whole private lane:
choose «только Прабхупада» and your own Prabhupada recording disappeared along
with everyone else's.

What the lane has instead is the speaker resolved when the track was indexed and
stamped on its chunks (`chunks.author_id`, the same column the public lane filters
by). So narrowing here is one join, and the rules are:

- their own recording of the chosen teacher stays;
- a stranger's talk goes;
- a recording with no resolved speaker goes too — under a constraint, "we don't
  know who this is" is not "this is them" — and the count of those is surfaced so
  the person can find out why their upload is missing;
- a DEFAULT never narrows this lane at all, and every failure fails open, because
  hiding a library is the worse error.
"""

from __future__ import annotations

import pytest

from lectorium_chat.application.author_scope import AuthorScope
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import LECTURE_AUTHORS, Attribute


_PRABHU = "author_prabhupada"
_MINE = "mine"
_THEIRS = "theirs"
_MYSTERY = "mystery"


class _Private:
    """The chunk repository's private-lane reads, answering off a fake stamp."""

    def __init__(self, by_track: dict[str, str | None]) -> None:
        self._by_track = by_track
        self.calls: list[tuple[str, list[str]]] = []

    async def get_owned_track_ids_by_author(self, user_id, author_ids):
        self.calls.append((user_id, list(author_ids)))
        return [
            t for t, a in self._by_track.items() if a and a in author_ids
        ]

    async def unattributed_owned_count(self, user_id):
        return sum(1 for a in self._by_track.values() if not a)


_LIBRARY = {_MINE: _PRABHU, _THEIRS: "author_other", _MYSTERY: None}


def _scope(
    private: object,
    *,
    explicit: bool = True,
    constrained: bool = True,
    user_id: str = "u-1",
) -> AuthorScope:
    scope = AuthorScope(
        catalog_repo=None, private_repo=private, user_id=user_id, request_id="req",
    )
    scope.apply(
        AuthorSelection.from_attributes({
            LECTURE_AUTHORS: Attribute(
                value=[_PRABHU], label="Прабхупада", explicit=explicit,
            ),
        })
        if constrained else AuthorSelection.unconstrained()
    )
    return scope


async def test_my_own_recording_of_the_chosen_teacher_survives() -> None:
    private = _Private(_LIBRARY)
    kept = await _scope(private).narrow_owned([_MINE, _THEIRS, _MYSTERY])
    assert kept == [_MINE]
    # Asked with the verified user id and the selected authors — the ACL and the
    # filter are one query, not a name-matching loop.
    assert private.calls == [("u-1", [_PRABHU])]


async def test_the_callers_list_stays_authoritative_for_access() -> None:
    # The repository may know about a track this turn's ACL list doesn't carry;
    # narrowing only ever REMOVES.
    private = _Private({**_LIBRARY, "not-in-acl": _PRABHU})
    assert await _scope(private).narrow_owned([_MINE]) == [_MINE]


async def test_order_is_the_callers() -> None:
    private = _Private({"a": _PRABHU, "b": _PRABHU})
    assert await _scope(private).narrow_owned(["b", "a"]) == ["b", "a"]


async def test_a_default_never_touches_the_library() -> None:
    # Nobody stated a choice, so nothing of theirs may be hidden — even though
    # the same selection narrows the public corpus.
    private = _Private(_LIBRARY)
    scope = _scope(private, explicit=False)
    assert await scope.narrow_owned([_MINE, _THEIRS]) == [_MINE, _THEIRS]
    assert private.calls == []


async def test_no_selection_leaves_the_library_alone() -> None:
    private = _Private(_LIBRARY)
    assert await _scope(private, constrained=False).narrow_owned([_THEIRS]) == [_THEIRS]
    assert private.calls == []


async def test_an_anonymous_turn_has_nothing_to_narrow() -> None:
    private = _Private(_LIBRARY)
    scope = _scope(private, user_id="")
    assert await scope.narrow_owned([_MINE]) == [_MINE]
    assert private.calls == []


@pytest.mark.parametrize("owned", [None, []])
async def test_an_empty_library_asks_nothing(owned) -> None:
    private = _Private(_LIBRARY)
    assert await _scope(private).narrow_owned(owned) == owned
    assert private.calls == []


async def test_a_query_failure_fails_open() -> None:
    class _Broken:
        async def get_owned_track_ids_by_author(self, *_a):
            raise RuntimeError("relation missing")

    # Hiding a library because a query is unavailable is the worse error.
    assert await _scope(_Broken()).narrow_owned([_MINE]) == [_MINE]


async def test_no_private_reader_at_all_fails_open() -> None:
    scope = AuthorScope(catalog_repo=None, user_id="u-1", request_id="req")
    scope.apply(AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=[_PRABHU], explicit=True),
    }))
    assert await scope.narrow_owned([_MINE]) == [_MINE]


async def test_the_private_lane_uses_the_owned_narrowing() -> None:
    """The wire, not just the rule: `corpus_fanout` must call `narrow_owned` for
    the private lane. Calling plain `narrow` there is what emptied it."""
    import inspect

    from lectorium_chat.research import corpus_fanout

    src = inspect.getsource(corpus_fanout)
    lane = src.split("async def _user_lecture")[1].split("async def ")[0]
    assert "narrow_owned(owned)" in lane
    assert "narrow(owned)" not in lane.replace("narrow_owned(owned)", "")


# ── the SQL behind it ─────────────────────────────────────────────────────


async def test_the_query_joins_owned_against_the_stamped_author() -> None:
    """The predicate itself: `owned` ⋈ `chunks.author_id`, restricted to the
    private kind, keyed on the verified user. Asserted on the SQL because the
    isolation (`kind = 'user_track'`) and the ACL (`o.user_id = $1`) are the two
    things that must never drift."""
    import inspect

    from lectorium_chat.infra.repositories.pg_chunk_repository import (
        PgChunkRepository,
    )

    sql = inspect.getsource(PgChunkRepository.get_owned_track_ids_by_author)
    assert "FROM owned o" in sql
    assert "c.kind = 'user_track'" in sql
    assert "o.user_id = $1" in sql
    assert "c.author_id = ANY($2::text[])" in sql

    counted = inspect.getsource(PgChunkRepository.unattributed_owned_count)
    assert "c.author_id IS NULL" in counted
    assert "o.user_id = $1" in counted
