"""Pins how a written-out teacher's name is matched against the corpus's names.

Every case below runs through the three bindings at the top, so the matcher can
be reshaped without the cases themselves changing.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from shruti_chat.application.author_lookup import resolve_author
from shruti_chat.composition import build_name_matcher

_MATCHER = build_name_matcher()


def _tokens(name: str) -> set[str]:
    return _MATCHER.distinctive_tokens(name)


def _match(query: str, candidate: str) -> bool:
    return _MATCHER.names_match(query, candidate)


async def _resolve(catalog, name: str):
    return await resolve_author(_MATCHER, catalog, name)


PRABHUPADA_EN = "A. C. Bhaktivedanta Swami Prabhupada"
PRABHUPADA_RU = "А. Ч. Бхактиведанта Свами Прабхупада"


@pytest.mark.parametrize(
    ("name", "tokens"),
    [
        ("Srila Prabhupada", {"prabhupada"}),
        ("Шрила Прабхупада", {"прабхупада"}),
        (PRABHUPADA_EN, {"bhaktivedanta", "prabhupada"}),
        (PRABHUPADA_RU, {"бхактиведанта", "прабхупада"}),
        ("His Divine Grace A. C. Bhaktivedanta Swami Prabhupada", {"bhaktivedanta", "prabhupada"}),
        ("Его Божественная Милость Прабхупада", {"прабхупада"}),
        ("Rohiṇī-suta Prabhu", {"rohini", "suta"}),
        ("Рохини-сута прабху", {"рохини", "сута"}),
        ("Bhakti-siddhānta Sarasvatī", {"siddhanta", "sarasvati"}),
        ("H.G. Rohini Suta Prabhu", {"rohini", "suta"}),
        ("Radha—Govinda (Dasa)", {"radha", "govinda"}),
        ("O'Brien / Smith", {"brien", "smith"}),
        ("Śrīla Bhaktivinoda Ṭhākura", {"bhaktivinoda"}),
        ("Suresh Kumar", {"suresh", "kumar"}),
        # A romanized honorific is still a token of its own script's name.
        ("Shrila Svami", set()),
        ("Госвами Махарадж", set()),
        ("", set()),
    ],
)
def test_distinctive_tokens(name: str, tokens: set[str]) -> None:
    assert _tokens(name) == tokens


@pytest.mark.parametrize(
    "name",
    ["Swami", "Свами", "Srila", "Шрила Свами", "His Divine Grace", "HH", "A. C.", "А. Ч.", "  "],
)
def test_a_name_of_honorifics_and_initials_denotes_nobody(name: str) -> None:
    assert _tokens(name) == set()
    assert _match(name, PRABHUPADA_EN) is False
    assert _match(PRABHUPADA_EN, name) is False


@pytest.mark.parametrize(
    ("query", "candidate", "expected"),
    [
        # Latin
        ("Srila Prabhupada", PRABHUPADA_EN, True),
        ("Bhaktivedanta", PRABHUPADA_EN, True),
        ("Niranjana Swami", PRABHUPADA_EN, False),
        ("Bhaktivedanta Sarasvati", PRABHUPADA_EN, False),
        # Cyrillic
        ("Шрила Прабхупада", PRABHUPADA_RU, True),
        ("Ниранджана Свами", PRABHUPADA_RU, False),
        # mixed scripts, both directions
        ("Srila Prabhupada", PRABHUPADA_RU, True),
        ("Прабхупада", PRABHUPADA_EN, True),
        ("Ниранджана Свами", PRABHUPADA_EN, False),
        # initials never count, so they neither help nor hurt
        ("A. C. Prabhupada", PRABHUPADA_EN, True),
        ("Prabhupada", "A. Prabhupada", True),
        # hyphens are separators
        ("Rohini-suta Prabhu", "Rohini Suta Prabhu", True),
        ("Rohini Suta", "Rohiṇī-suta Prabhu", True),
        ("Рохини-сута", "Рохини сута прабху", True),
        # a private upload carries one spelling: reached through romanization
        ("Рохини сута прабху", "Rohini Suta Prabhu", True),
        ("Rohini Suta", "Рохини-сута прабху", True),
        ("Рохини сута", "H.G. Rohini Suta Prabhu", True),
        ("Рохини сута", "Bhakti Caitanya Swami", False),
        # transliteration drift within the token threshold
        ("bhaktivinode", "Śrīla Bhaktivinoda Ṭhākura", True),
        ("Бхактивинод", "Bhaktivinoda Thakura", True),
        ("Krsna", "Krishna Das", False),
    ],
)
def test_names_match(query: str, candidate: str, expected: bool) -> None:
    assert _match(query, candidate) is expected


@dataclass
class _Hit:
    id: str
    full_name: str


class _Catalog:
    def __init__(self, rows: list[_Hit]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, str, str | None, int]] = []

    async def resolve(self, kind, text, *, lang, limit):
        self.calls.append((kind, text, lang, limit))
        return list(self.rows)


class _Unreachable:
    async def resolve(self, kind, text, *, lang, limit):
        raise RuntimeError("catalog gone")


async def test_resolve_asks_across_locales_for_a_few_candidates() -> None:
    catalog = _Catalog([_Hit("a1", PRABHUPADA_EN)])
    assert (await _resolve(catalog, "  Srila Prabhupada ")).id == "a1"
    assert catalog.calls == [("author", "Srila Prabhupada", None, 5)]


async def test_resolve_prefers_the_row_in_the_script_that_was_asked() -> None:
    en, ru = _Hit("a1-en", PRABHUPADA_EN), _Hit("a1-ru", PRABHUPADA_RU)
    # Romanized matching would accept the first row; the same-script row wins.
    assert (await _resolve(_Catalog([en, ru]), "Прабхупада")) is ru
    assert (await _resolve(_Catalog([ru, en]), "Prabhupada")) is en


async def test_resolve_falls_back_to_a_romanized_match() -> None:
    row = _Hit("private", "Rohini Suta Prabhu")
    catalog = _Catalog([_Hit("a1", PRABHUPADA_EN), row])
    assert (await _resolve(catalog, "Рохини сута")) is row


async def test_resolve_keeps_the_catalog_order_within_a_pass() -> None:
    first, second = _Hit("a1", PRABHUPADA_EN), _Hit("a2", "Prabhupada Das")
    assert (await _resolve(_Catalog([first, second]), "Prabhupada")) is first


async def test_resolve_finds_nobody_for_a_name_the_corpus_lacks() -> None:
    catalog = _Catalog([_Hit("a1", PRABHUPADA_EN), _Hit("a1", PRABHUPADA_RU)])
    assert await _resolve(catalog, "Niranjana Swami") is None
    assert await _resolve(catalog, "Swami") is None


@pytest.mark.parametrize("name", ["", "   "])
async def test_resolve_does_not_ask_about_an_empty_name(name: str) -> None:
    catalog = _Catalog([_Hit("a1", PRABHUPADA_EN)])
    assert await _resolve(catalog, name) is None
    assert catalog.calls == []


async def test_resolve_without_a_catalog_finds_nobody() -> None:
    assert await _resolve(None, "Prabhupada") is None


async def test_resolve_with_an_unreachable_catalog_finds_nobody() -> None:
    assert await _resolve(_Unreachable(), "Prabhupada") is None
