"""Domain author matching and resolution logic."""

from __future__ import annotations

import unicodedata
from typing import Any

from rapidfuzz import fuzz

_HONORIFICS = frozenset({
    # latin
    "srila", "sri", "shri", "shrila", "sriman", "sripad", "sripada",
    "his", "her", "divine", "grace", "holiness", "hh", "hg", "hdg",
    "swami", "svami", "goswami", "gosvami", "maharaja", "maharaj",
    "prabhu", "prabhuji", "das", "dasa", "dasi", "devi", "mataji",
    "thakura", "thakur", "acarya", "acharya", "bhakti",
    # cyrillic
    "шрила", "шри", "шриман", "шрипад",
    "его", "её", "ее", "божественная", "милость", "святость",
    "свами", "госвами", "махараджа", "махарадж",
    "прабху", "прабхуджи", "дас", "даса", "даси", "деви", "матаджи",
    "тхакура", "тхакур", "ачарья", "бхакти",
})

_TOKEN_SIMILARITY = 88.0

_CYR_TO_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _romanize(token: str) -> str:
    return "".join(_CYR_TO_LAT.get(c, c) for c in token)


def distinctive_tokens(name: str) -> set[str]:
    folded = _fold(name)
    for ch in ".,-–—‑'\"()/":
        folded = folded.replace(ch, " ")
    return {
        t for t in folded.split()
        if len(t) > 1 and t not in _HONORIFICS
    }


def _romanized(tokens: set[str]) -> set[str]:
    return {_romanize(t) for t in tokens}


def names_match(query: str, candidate: str) -> bool:
    wanted = distinctive_tokens(query)
    if not wanted:
        return False
    have = distinctive_tokens(candidate)
    if not have:
        return False
    if _covers(wanted, have):
        return True
    return _covers(_romanized(wanted), _romanized(have))


def _covers(wanted: set[str], have: set[str]) -> bool:
    return all(
        any(fuzz.ratio(w, h) >= _TOKEN_SIMILARITY for h in have)
        for w in wanted
    )


def _covers_same_script(query: str, candidate: str) -> bool:
    wanted, have = distinctive_tokens(query), distinctive_tokens(candidate)
    return bool(wanted and have and _covers(wanted, have))


CANDIDATES = 5


async def resolve_author(catalog_repo: Any, name: str) -> Any | None:
    text = (name or "").strip()
    if not text or catalog_repo is None:
        return None
    try:
        hits = await catalog_repo.resolve(
            "author", text, lang=None, limit=CANDIDATES,
        )
    except Exception:  # noqa: BLE001
        return None

    for hit in hits:
        if _covers_same_script(text, hit.full_name):
            return hit
    for hit in hits:
        if names_match(text, hit.full_name):
            return hit
    return None
