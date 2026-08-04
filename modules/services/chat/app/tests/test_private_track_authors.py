"""A lecturer filter reaches someone's OWN uploads instead of hiding them.

Their tracks are not in the published catalog, so the catalog-derived track-id set
says nothing about them — and intersecting with it emptied the whole private lane:
choose «только Прабхупада» and your own Prabhupada recording disappeared along
with everyone else's. What the private lane has instead is what the ingest heard,
a free-text speaker name per track (`user_track_facts.data->>'author_raw'`,
projected from `track.ready`).

So the question asked of an upload is the one asked of a typed name — does this
name denote the chosen author? — through the same cross-script lookup. Which makes
«Прабхупада» on an upload match the catalog's Latin
"A. C. Bhaktivedanta Swami Prabhupada", and keeps a stranger's talk out.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from lectorium_chat.application.author_scope import AuthorScope
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import LECTURE_AUTHORS, Attribute


_PRABHU = "author_prabhupada"
_OTHER = "author_other"


@dataclass
class _Hit:
    id: str
    full_name: str


class _Catalog:
    """Multi-locale dictionary, like the real one."""

    def __init__(self) -> None:
        self.resolves: list[str] = []

    async def resolve(self, kind, text, *, lang, limit):
        self.resolves.append(text)
        return [
            _Hit(_PRABHU, "A. C. Bhaktivedanta Swami Prabhupada"),
            _Hit(_PRABHU, "А. Ч. Бхактиведанта Свами Прабхупада"),
            _Hit(_OTHER, "Niranjana Swami"),
        ]

    async def filter_track_ids(self, **_kw):
        # The published corpus knows nothing about anyone's uploads.
        return []


class _Facts:
    def __init__(self, by_track: dict[str, str]) -> None:
        self._by_track = by_track
        self.asked: list[list[str]] = []

    async def get_track_authors_raw(self, track_ids):
        self.asked.append(list(track_ids))
        return {
            t: self._by_track[t] for t in track_ids
            if self._by_track.get(t)
        }


def _scope(facts, catalog=None, *, explicit: bool = True, constrained: bool = True):
    scope = AuthorScope(
        catalog_repo=catalog or _Catalog(), facts_repo=facts, request_id="req",
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
    # The whole point: the catalog says the selection allows NO tracks, and this
    # upload is still kept, because the speaker is who was asked for.
    facts = _Facts({"mine": "Прабхупада"})
    scope = _scope(facts)
    assert await scope.track_ids() == []
    assert await scope.narrow_owned(["mine"]) == ["mine"]


async def test_a_latin_name_on_the_upload_matches_a_cyrillic_request() -> None:
    facts = _Facts({"mine": "Srila Prabhupada"})
    assert await _scope(facts).narrow_owned(["mine"]) == ["mine"]


async def test_someone_elses_teacher_is_dropped() -> None:
    facts = _Facts({"theirs": "Niranjana Swami"})
    assert await _scope(facts).narrow_owned(["theirs"]) == []


async def test_an_upload_with_no_recorded_speaker_is_dropped() -> None:
    # Under a constraint, "we don't know who this is" is not "this is them" —
    # the same rule the corpus lane applies to an unattributable lecture.
    facts = _Facts({"mystery": ""})
    assert await _scope(facts).narrow_owned(["mystery"]) == []


async def test_a_name_the_corpus_never_heard_of_is_dropped() -> None:
    class _Empty(_Catalog):
        async def resolve(self, kind, text, *, lang, limit):
            self.resolves.append(text)
            return []

    facts = _Facts({"mine": "Some Visiting Speaker"})
    assert await _scope(facts, _Empty()).narrow_owned(["mine"]) == []


async def test_a_default_never_touches_the_library() -> None:
    # Nobody stated a choice, so nothing of theirs may be hidden — even though
    # the same selection narrows the public corpus.
    facts = _Facts({"mine": "Niranjana Swami"})
    scope = _scope(facts, explicit=False)
    assert await scope.narrow_owned(["mine"]) == ["mine"]
    assert facts.asked == []


async def test_no_selection_leaves_the_library_alone() -> None:
    facts = _Facts({"mine": "Anyone"})
    assert await _scope(facts, constrained=False).narrow_owned(["mine"]) == ["mine"]
    assert facts.asked == []


async def test_the_same_speaker_is_resolved_once_for_many_tracks() -> None:
    facts = _Facts({f"t{i}": "Прабхупада" for i in range(5)})
    catalog = _Catalog()
    kept = await _scope(facts, catalog).narrow_owned([f"t{i}" for i in range(5)])
    assert len(kept) == 5
    assert catalog.resolves == ["Прабхупада"]


async def test_a_facts_lookup_failure_fails_open() -> None:
    class _Broken:
        async def get_track_authors_raw(self, _ids):
            raise RuntimeError("table missing")

    # Hiding a library because a projection is unavailable is the worse error.
    assert await _scope(_Broken()).narrow_owned(["mine"]) == ["mine"]


async def test_no_facts_reader_at_all_fails_open() -> None:
    scope = AuthorScope(catalog_repo=_Catalog(), request_id="req")
    scope.apply(AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=[_PRABHU], explicit=True),
    }))
    assert await scope.narrow_owned(["mine"]) == ["mine"]


@pytest.mark.parametrize("owned", [None, []])
async def test_an_empty_library_asks_nothing(owned) -> None:
    facts = _Facts({})
    assert await _scope(facts).narrow_owned(owned) == owned
    assert facts.asked == []


async def test_the_private_lane_uses_the_owned_narrowing() -> None:
    """The wire, not just the rule: `corpus_fanout` must call `narrow_owned` for
    the private lane. Calling plain `narrow` there is what emptied it."""
    import inspect

    from lectorium_chat.research import corpus_fanout

    src = inspect.getsource(corpus_fanout)
    lane = src.split("async def _user_lecture")[1].split("async def ")[0]
    assert "narrow_owned(owned)" in lane
    assert "narrow(owned)" not in lane.replace("narrow_owned(owned)", "")
