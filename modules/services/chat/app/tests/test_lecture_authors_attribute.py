"""Asking for a lecturer in words, and what the server does with the name.

The model returns NAMES — it cannot know the catalog's ids, and a guessed id
would be a filter that silently matches nothing. So the server resolves them,
and the interesting cases are all about what happens when a name doesn't land:

- nothing resolves ⇒ no filter at all. A narrowing to a teacher the corpus does
  not have would empty every following answer and read as "there is nothing on
  this", which is not what anyone asked for.
- some resolve ⇒ keep those. The user named who they wanted; widening back to
  everyone would answer from people they excluded.

The prompt's own job — telling «отвечай только по Прабхупаде» apart from «есть
лекции Прабхупады?» — is asserted on the wording in
`test_lecture_authors_prompt.py`; a live model is the only thing that can settle
the rest.
"""

from __future__ import annotations

from dataclasses import dataclass

from lectorium_chat.application.conversation_attributes import (
    LectureAuthorsOut,
    LectureAuthorsSpec,
)
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import ALL, LECTURE_AUTHORS


_PRABHU_EN = "A. C. Bhaktivedanta Swami Prabhupada"
_PRABHU_RU = "А. Ч. Бхактиведанта Свами Прабхупада"
_BVT_EN = "Śrīla Bhaktivinoda Ṭhākura"
_BVT_RU = "Шрила Бхактивинода Тхакур"


@dataclass
class _Hit:
    id: str
    full_name: str


class _Catalog:
    """Resolves like the real one: across locales, returning the row whose text
    matched. Only the authors listed here exist."""

    def __init__(self, rows: list[_Hit]) -> None:
        self.rows = rows
        self.queries: list[str] = []

    async def resolve(self, kind, text, *, lang, limit):
        self.queries.append(text)
        assert kind == "author"
        assert lang is None, "a name may be typed in any script — resolve across locales"
        return list(self.rows)


# One row PER LOCALE, like the real dictionary. A single row per author is the
# shape that cannot show a cross-script match at all.
_CATALOG = [
    _Hit("author_prabhupada", _PRABHU_EN),
    _Hit("author_prabhupada", _PRABHU_RU),
    _Hit("author_bvt", _BVT_EN),
    _Hit("author_bvt", _BVT_RU),
]


async def _build(out: LectureAuthorsOut, catalog: _Catalog | None = None):
    return await LectureAuthorsSpec().build(
        out, catalog_repo=catalog or _Catalog(_CATALOG), request_id="req",
    )


async def test_a_named_teacher_becomes_their_catalog_id() -> None:
    attr = await _build(LectureAuthorsOut(names=["Srila Prabhupada"]))
    assert attr is not None
    assert attr.value == ["author_prabhupada"]
    # The label is the corpus's own name, not what the user typed — it is what an
    # honest "nothing by them" line has to show.
    assert attr.label == _PRABHU_EN
    # Only ever set by someone asking, so it outranks any later inference.
    assert attr.explicit


async def test_a_name_in_another_script_still_lands() -> None:
    # Typed in Cyrillic, and the label comes back in Cyrillic: the row that
    # MATCHED is the one shown, not whichever locale happens to be stored last.
    attr = await _build(LectureAuthorsOut(names=["Бхактивинода"]))
    assert attr is not None and attr.value == ["author_bvt"]
    assert attr.label == _BVT_RU


async def test_two_teachers_keep_their_order() -> None:
    attr = await _build(
        LectureAuthorsOut(names=["Bhaktivinoda", "Srila Prabhupada"]),
    )
    assert attr is not None
    assert attr.value == ["author_bvt", "author_prabhupada"]
    assert attr.label == f"{_BVT_EN}, {_PRABHU_EN}"


async def test_the_same_teacher_twice_is_one_entry() -> None:
    attr = await _build(
        LectureAuthorsOut(names=["Prabhupada", "Srila Prabhupada"]),
    )
    assert attr is not None and attr.value == ["author_prabhupada"]


async def test_asking_for_everyone_lifts_the_filter() -> None:
    attr = await _build(LectureAuthorsOut(everyone=True))
    assert attr is not None and attr.value == [ALL]
    # And it reads downstream as "no constraint", which is the whole point of
    # having a value for it instead of removing the attribute.
    assert not AuthorSelection.from_attributes({LECTURE_AUTHORS: attr}).constrained


async def test_everyone_never_hits_the_catalog() -> None:
    catalog = _Catalog(_CATALOG)
    await _build(LectureAuthorsOut(everyone=True, names=["Prabhupada"]), catalog)
    assert catalog.queries == []


async def test_a_message_about_no_teacher_settles_nothing() -> None:
    assert await _build(LectureAuthorsOut()) is None
    assert await _build(LectureAuthorsOut(names=["", "   "])) is None


async def test_a_teacher_the_corpus_never_heard_of_sets_no_filter() -> None:
    # Fail OPEN. The alternative is every later answer silently empty, which is
    # indistinguishable from "the corpus has nothing to say on this".
    attr = await _build(
        LectureAuthorsOut(names=["Bhakti Caitanya Swami"]), _Catalog(_CATALOG),
    )
    assert attr is None


async def test_one_unknown_name_does_not_widen_the_others_away() -> None:
    attr = await _build(
        LectureAuthorsOut(names=["Srila Prabhupada", "Bhakti Caitanya Swami"]),
    )
    assert attr is not None and attr.value == ["author_prabhupada"]


async def test_a_catalog_hiccup_is_a_missing_name_not_a_dead_turn() -> None:
    class _Broken:
        async def resolve(self, *_a, **_k):
            raise RuntimeError("catalog locked")

    assert await _build(LectureAuthorsOut(names=["Prabhupada"]), _Broken()) is None


async def test_a_runaway_list_is_capped() -> None:
    catalog = _Catalog(_CATALOG)
    await _build(
        LectureAuthorsOut(names=[f"Teacher {i}" for i in range(20)]), catalog,
    )
    assert len(catalog.queries) == 8


async def test_the_detector_is_registered() -> None:
    from lectorium_chat.application.conversation_attributes import ATTRIBUTE_SPECS

    keys = [s.key for s in ATTRIBUTE_SPECS]
    assert LECTURE_AUTHORS in keys
    # One prompt per attribute, hosted separately in Langfuse.
    names = [s.prompt_name for s in ATTRIBUTE_SPECS]
    assert len(set(names)) == len(names)
