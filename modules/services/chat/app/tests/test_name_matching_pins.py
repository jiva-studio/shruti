"""The corpus name matcher's decision for every pair of a mixed-script name set.

`MATCHING` holds the (query, candidate) index pairs that match. A flipped True
is a teacher the router attributes wrongly, a flipped False one the corpus
reads as absent. Some False pairs look like they should match (a Latin and a
Cyrillic spelling whose romanization drifts too far); they are pinned as they
are, and a deliberate change to them updates this table.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.application.conversation_attributes import detect_attributes
from shruti_chat.composition import build_name_matcher
from shruti_chat.domain.name_matching import NameMatcher

NAMES = [
    "Srila Prabhupada", "A. C. Bhaktivedanta Swami Prabhupada", "Шрила Прабхупада",
    "А. Ч. Бхактиведанта Свами Прабхупада", "Niranjana Swami", "Ниранджана Свами",
    "Rohini Suta Prabhu", "Rohini-suta Prabhu", "Рохини сута прабху", "Rohiṇī-suta dāsa",
    "Bhaktivinoda Thakura", "Bhaktivinode Ṭhākura", "Бхактивинода Тхакур", "Swami", "Свами",
    "Ёлкин Йог", "Елкин Иог", "Jayapataka Swami", "Джаяпатака Свами", "कृष्ण दास", "कृष्णदास",
    "Bhakti-rasamrita Swami", "Bhakti Rasamrita Swami", "Индира деви даси", "Indira devi dasi",
]

MATCHING = {
    (0, 0), (0, 1), (0, 2), (0, 3), (1, 1), (1, 3), (2, 0), (2, 1), (2, 2), (2, 3),
    (3, 1), (3, 3), (4, 4), (5, 5), (6, 6), (6, 7), (6, 8), (6, 9), (7, 6), (7, 7),
    (7, 8), (7, 9), (8, 6), (8, 7), (8, 8), (8, 9), (9, 6), (9, 7), (9, 8), (9, 9),
    (10, 10), (10, 11), (10, 12), (11, 10), (11, 11), (11, 12), (12, 10), (12, 11),
    (12, 12), (15, 15), (15, 16), (16, 15), (16, 16), (17, 17), (18, 18), (19, 19),
    (20, 20), (21, 21), (21, 22), (22, 21), (22, 22), (23, 23), (23, 24), (24, 23),
    (24, 24),
}


@pytest.fixture(scope="module")
def matcher() -> NameMatcher:
    return build_name_matcher()


def test_every_pair_is_decided_as_before(matcher: NameMatcher) -> None:
    got = {
        (i, j)
        for i, q in enumerate(NAMES)
        for j, c in enumerate(NAMES)
        if matcher.names_match(q, c)
    }
    assert sorted(got - MATCHING) == [], "pairs that now match"
    assert sorted(MATCHING - got) == [], "pairs that no longer match"


@dataclass(frozen=True)
class _Row:
    full_name: str


@pytest.mark.parametrize(
    ("asked", "expected"),
    [
        # Same script wins even when the other script's row comes first.
        ("Шрила Прабхупада", "А. Ч. Бхактиведанта Свами Прабхупада"),
        ("Srila Prabhupada", "A. C. Bhaktivedanta Swami Prabhupada"),
        # Only the romanized pass reaches a Latin-only private spelling.
        ("Рохини сута прабху", "Rohini Suta Prabhu"),
        # Nothing but titles denotes nobody, whatever the pool holds.
        ("Свами", None),
        ("His Divine Grace", None),
    ],
)
def test_select_returns_the_row_in_the_script_asked(
    matcher: NameMatcher, asked: str, expected: str | None,
) -> None:
    pool = [
        _Row("A. C. Bhaktivedanta Swami Prabhupada"),
        _Row("А. Ч. Бхактиведанта Свами Прабхупада"),
        _Row("Rohini Suta Prabhu"),
        _Row("Swami"),
    ]
    hit = matcher.select(asked, pool)
    assert (hit.full_name if hit else None) == expected


def test_a_matcher_without_the_corpus_conventions_misses_the_corpus_author() -> None:
    # Why neither `TurnContext` nor `detect_attributes` defaults to a bare
    # `NameMatcher()`: the headline case of the corpus stops resolving.
    bare = NameMatcher()
    assert not bare.names_match("Srila Prabhupada", "A. C. Bhaktivedanta Swami Prabhupada")
    assert build_name_matcher().names_match(
        "Srila Prabhupada", "A. C. Bhaktivedanta Swami Prabhupada",
    )


def test_a_turn_context_cannot_be_built_without_a_matcher() -> None:
    with pytest.raises(TypeError, match="name_matcher"):
        TurnContext()  # type: ignore[call-arg]


async def test_attribute_detection_cannot_run_without_a_matcher() -> None:
    with pytest.raises(TypeError, match="name_matcher"):
        await detect_attributes("q", llm=None)  # type: ignore[call-arg]
