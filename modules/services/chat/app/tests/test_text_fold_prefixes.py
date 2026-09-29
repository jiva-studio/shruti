"""Title search stays prefix-complete under the shared fold.

Someone typing a title types it one character at a time; every prefix of every
word must keep matching, whatever script the title is in. The fold keeps an
Indic vowel sign (class 0) and drops a virama or nukta (non-zero class), so a
prefix cut between a consonant and its sign, or after a virama, is the case
this pins — in Devanagari and Bengali as well as IAST and Cyrillic.
"""

from __future__ import annotations

import pytest

from shruti_chat.domain.text_fold import fold, matches, tokens

TITLES = [
    "Śrīmad-Bhāgavatam 1.2.6",
    "Бхагавад-гита как она есть — Йога знания",
    "Ёлка и йога",
    "श्रीमद्भगवद्गीता कृष्ण प्रभुपाद",
    "শ্রীচৈতন্য চরিতামৃত",
    "Kṛṣṇa, the Supreme Personality of Godhead",
]


def _prefixes(title: str) -> list[tuple[str, str]]:
    out = []
    for word in title.split():
        for end in range(1, len(word) + 1):
            out.append((word, word[:end]))
    return out


@pytest.mark.parametrize("title", TITLES)
def test_every_prefix_of_every_word_matches_its_title(title: str) -> None:
    for word, prefix in _prefixes(title):
        q = tokens(prefix)
        assert matches(title, q), (word, prefix, q)


@pytest.mark.parametrize("title", TITLES)
def test_fold_is_idempotent(title: str) -> None:
    assert fold(fold(title)) == fold(title)


def test_a_vowel_sign_distinguishes_words_a_virama_does_not() -> None:
    # कृष्ण vs कष्ण: the vocalic-r sign is a letter; the virama is dropped.
    assert fold("कृष्ण") != fold("कष्ण")
    assert fold("क्ष") == fold("कष")
    assert not matches("कष्ण", tokens("कृ"))
