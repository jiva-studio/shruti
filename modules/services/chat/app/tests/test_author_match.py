"""Unit tests for application.author_names — deciding whether a name the
router extracted denotes one of the corpus's authors.

The hard part is that every Vaiṣṇava teacher's name is mostly honorifics, so a
fuzzy ratio cannot separate "Srila Prabhupada" (ours) from "Bhakti Caitanya
Swami" (not ours) — they score 0.77 and 0.62 against the same pool. These tests
pin the containment rule that does separate them, in both scripts — and across
them: comparison falls back to a romanized pass, because a privately added
recording carries exactly one spelling of its speaker's name.
"""

from __future__ import annotations

import pytest

from shruti_chat.application.author_names import (
    distinctive_tokens,
    names_match,
)

PRABHUPADA_EN = "A. C. Bhaktivedanta Swami Prabhupada"
PRABHUPADA_RU = "А. Ч. Бхактиведанта Свами Прабхупада"
BHAKTIVINODA_EN = "Śrīla Bhaktivinoda Ṭhākura"


@pytest.mark.parametrize(
    ("query", "candidate"),
    [
        ("Srila Prabhupada", PRABHUPADA_EN),
        # Across scripts, in both directions. The dictionary carries a row per
        # locale, so a catalog author was already reachable either way by lookup —
        # but a PRIVATE upload has exactly one spelling, and «Рохини сута прабху»
        # had no way to reach the "Rohini Suta Prabhu" its ingest wrote.
        ("Srila Prabhupada", PRABHUPADA_RU),
        ("Прабхупада", PRABHUPADA_EN),
        ("Бхактиведанта Свами", PRABHUPADA_EN),
        ("Prabhupada", PRABHUPADA_EN),
        ("prabhupada", PRABHUPADA_EN),
        ("Bhaktivedanta Swami", PRABHUPADA_EN),
        ("His Divine Grace A. C. Bhaktivedanta Swami Prabhupada", PRABHUPADA_EN),
        (PRABHUPADA_EN, PRABHUPADA_EN),
        ("Шрила Прабхупада", PRABHUPADA_RU),
        ("Прабхупада", PRABHUPADA_RU),
        (PRABHUPADA_RU, PRABHUPADA_RU),
        # Diacritics must fold: "Thakura" is "Ṭhākura".
        ("Bhaktivinoda Thakura", BHAKTIVINODA_EN),
        ("bhaktivinode", BHAKTIVINODA_EN),
    ],
)
def test_names_that_denote_the_candidate(query: str, candidate: str) -> None:
    assert names_match(query, candidate) is True


@pytest.mark.parametrize(
    ("query", "candidate"),
    [
        # Shares ONLY the honorific "Swami" — the collision that made the old
        # score cutoff unreliable.
        ("Niranjana Swami", PRABHUPADA_EN),
        ("Bhakti Caitanya Swami", PRABHUPADA_EN),
        ("Krishna Ksetra Swami", PRABHUPADA_EN),
        ("Rohini Suta Prabhu", PRABHUPADA_EN),
        ("Bir Krishna Goswami", PRABHUPADA_EN),
        ("Suresh Kumar", PRABHUPADA_EN),
        ("Ниранджана Свами", PRABHUPADA_RU),
        ("Бхакти Чайтанья Свами", PRABHUPADA_RU),
        # Cross-script, and still a DIFFERENT teacher: romanizing the query must
        # not turn "shares an honorific" into a match.
        ("Ниранджана Свами", PRABHUPADA_EN),
        ("Рохини сута прабху", PRABHUPADA_EN),
        # A DIFFERENT corpus author is still not this one.
        ("Bhaktivinoda Thakura", PRABHUPADA_EN),
        # Naming MORE than the candidate does not match: the rule is directional.
        ("Bhaktivedanta Sarasvati", PRABHUPADA_EN),
    ],
)
def test_names_that_do_not_denote_the_candidate(query: str, candidate: str) -> None:
    assert names_match(query, candidate) is False


@pytest.mark.parametrize("name", ["Swami", "Свами", "Srila", "His Divine Grace", "  ", ""])
def test_honorifics_alone_are_not_distinctive(name: str) -> None:
    # These denote no particular teacher, so the caller must neither claim the
    # corpus lacks them nor guess an author filter.
    assert distinctive_tokens(name) == set()
    assert names_match(name, PRABHUPADA_EN) is False


def test_initials_are_not_distinctive() -> None:
    assert distinctive_tokens(PRABHUPADA_EN) == {"bhaktivedanta", "prabhupada"}
    assert distinctive_tokens(PRABHUPADA_RU) == {"бхактиведанта", "прабхупада"}
