"""`domain.text_fold`: accent- and case-insensitive title and name matching."""

from __future__ import annotations

import unicodedata

import pytest

from shruti_chat.domain.author_lookup import distinctive_tokens, names_match
from shruti_chat.domain.text_fold import fold, matches, tokens


def test_fold_strips_marks_and_case() -> None:
    assert fold("Śrīmad-Bhāgavatam") == "srimad-bhagavatam"
    assert fold("ЁЛКА") == "елка"


def test_tokens_drop_pure_punctuation() -> None:
    assert tokens("Bhagavad — Gītā !") == ["bhagavad", "gita"]
    assert tokens(" -- ") == []


def test_matches_requires_every_query_token_as_a_prefix() -> None:
    title = "Śrīmad Bhāgavatam Canto One"
    assert matches(title, ["sri", "bhag"])
    assert not matches(title, ["sri", "gita"])
    assert matches(title, [])


# ── one fold for titles and names ─────────────────────────────────────
#
# Title search folded by dropping general category Mn; teacher-name matching
# folded by dropping a non-zero combining class. `fold` is now both. The two
# recipes agree on every Latin, IAST, Cyrillic and Greek letter; they part
# only on class-0 nonspacing marks (Indic vowel signs, variation selectors),
# which `fold` keeps. The corpus below is what the catalog and the people
# asking actually write.


def _title_fold_by_category(s: str) -> str:
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn").casefold()


def _name_fold_by_combining_class(s: str) -> str:
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


_CORPUS = [
    # teachers, as the catalog and the router spell them
    "A. C. Bhaktivedanta Swami Prabhupada",
    "А. Ч. Бхактиведанта Свами Прабхупада",
    "His Divine Grace A. C. Bhaktivedanta Svāmī Prabhupāda",
    "Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura",
    "Шрила Бхактисиддханта Сарасвати Тхакур",
    "Bhaktivinoda Ṭhākura",
    "Rohiṇī-suta Prabhu",
    "Рохини-сута прабху",
    "Niranjana Swami",
    "Ниранджана Свами",
    "Śrī Caitanya Mahāprabhu",
    "Ёжиков Пётр",
    "Rādhānātha Svāmī",
    "Јаја Радхе Дас",
    "Čaitanja Čandra Dasa",
    "Đorđe Šušnjević",
    "Ґанґа Їжакевич Єва",
    "Gauḍīya Maṭha",
    "STRAẞE Weiß",
    "ﬁnal ﬂight",
    "Ｆｕｌｌ　Ｗｉｄｔｈ",
    "Kṛṣṇa-kathāmṛta",
    # titles and scripture addresses
    "Śrīmad-Bhāgavatam 1.2.6",
    "Бхагавад-гита 2.13",
    "Шримад-Бхагаватам, песнь 10",
    "Śikṣāṣṭaka 1",
    "Nectar of Devotion — lecture, Vṛndāvana 1972",
    "Лекция по «Шри Ишопанишад», мантра 1",
    "Brahma-saṁhitā 5.1",
    "Ὀδυσσεύς",
]


@pytest.mark.parametrize("text", _CORPUS)
def test_the_shared_fold_agrees_with_both_former_recipes(text: str) -> None:
    assert fold(text) == _title_fold_by_category(text)
    assert fold(text) == _name_fold_by_combining_class(text)


def test_an_indic_vowel_sign_is_a_letter_not_an_accent() -> None:
    # U+0941 DEVANAGARI VOWEL SIGN U: nonspacing, combining class 0.
    assert fold("प्रभुपाद") == _name_fold_by_combining_class("प्रभुपाद")
    assert "ु" in fold("प्रभुपाद")


def test_names_still_match_across_diacritics_and_hyphens() -> None:
    assert names_match("Srila Prabhupada", "A. C. Bhaktivedanta Swami Prabhupāda")
    assert names_match("Rohini Suta", "Rohiṇī-suta Prabhu")
    assert names_match("Рохини сута", "Rohini Suta Prabhu")
    assert not names_match("Niranjana Swami", "A. C. Bhaktivedanta Swami Prabhupada")
    assert distinctive_tokens("Śrīla Bhaktivinoda Ṭhākura") == {"bhaktivinoda"}
