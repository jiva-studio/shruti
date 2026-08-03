"""Unit tests for agent.graph.nodes._author_match — deciding whether a name the
router extracted denotes one of the corpus's authors.

The hard part is that every Vaiṣṇava teacher's name is mostly honorifics, so a
fuzzy ratio cannot separate "Srila Prabhupada" (ours) from "Bhakti Caitanya
Swami" (not ours) — they score 0.77 and 0.62 against the same pool. These tests
pin the containment rule that does separate them, in both scripts.
"""

from __future__ import annotations

import pytest

from lectorium_chat.agent.graph.nodes._author_match import (
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
        # A DIFFERENT corpus author is still not this one.
        ("Bhaktivinoda Thakura", PRABHUPADA_EN),
        # Cross-script comparison cannot succeed textually — which is exactly why
        # the caller must resolve across all locales rather than rely on this.
        ("Srila Prabhupada", PRABHUPADA_RU),
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
