"""How the teachers of this corpus are named, in Latin and in Cyrillic.

A Vaiṣṇava teacher's name is mostly titles ("Srila", "Swami", "Prabhu", "His
Divine Grace"), so these are dropped: "Srila Prabhupada" then denotes "A. C.
Bhaktivedanta Swami Prabhupada", while "Niranjana Swami", which shares only a
title, does not. "swami" is part of a full name too; dropping it from both sides
keeps the comparison symmetric.

Cyrillic is romanized for comparison only, practically rather than by a
standard («прабху» → "prabhu"), because a private upload carries one spelling:
«Рохини сута прабху» has to reach "Rohini Suta Prabhu".
"""

from __future__ import annotations

from dataclasses import dataclass

_TITLES = frozenset({
    # latin
    "srila", "sri", "shri", "shrila", "sriman", "sripad", "sripada",
    "his", "her", "divine", "grace", "holiness", "hh", "hg", "hdg",
    "swami", "svami", "goswami", "gosvami", "maharaja", "maharaj",
    "prabhu", "prabhuji", "das", "dasa", "dasi", "devi", "mataji",
    "thakura", "thakur", "acarya", "acharya", "bhakti",
    # cyrillic
    "шрила", "шри", "шриман", "шрипад",
    "его", "ее", "божественная", "милость", "святость",
    "свами", "госвами", "махараджа", "махарадж",
    "прабху", "прабхуджи", "дас", "даса", "даси", "деви", "матаджи",
    "тхакура", "тхакур", "ачарья", "бхакти",
})

# Folded input only: "ё" and "й" have already lost their marks.
_CYR_TO_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e",
    "ж": "zh", "з": "z", "и": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


@dataclass(frozen=True)
class VaishnavaNaming:
    titles: frozenset[str] = _TITLES

    def romanize(self, token: str) -> str:
        return "".join(_CYR_TO_LAT.get(c, c) for c in token)


VAISHNAVA_NAMING = VaishnavaNaming()
