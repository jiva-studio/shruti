"""Does a written-out teacher's name denote a corpus author?

A name reaches us in whatever language it was written — the router normalizes the
speaker it extracts to English ("Шрила Прабхупада" → "Srila Prabhupada"), a
person asking for a lecturer types their own script — so it can never be compared
against one locale's dictionary alone: a Latin query scores ~0.04 against the
Cyrillic "А. Ч. Бхактиведанта Свами Прабхупада" and the corpus's OWN author reads
as absent. Callers therefore resolve across ALL locales and decide here.

Comparison itself also falls back to a romanized pass, for the case a dictionary
cannot help with: a privately added recording carries ONE spelling of its speaker
— whatever the ingest wrote — so «Рохини сута прабху» has to reach "Rohini Suta
Prabhu" on its own. Same-script matching runs first, so a name still comes back in
the script it was asked in.

The decision is token containment, not a fuzzy threshold: strip the honorifics
("Srila", "Swami", "His Divine Grace", …) from both sides and require every
remaining DISTINCTIVE token of the query to appear in the candidate. That is
what makes "Srila Prabhupada" a match for "A. C. Bhaktivedanta Swami
Prabhupada" while "Niranjana Swami" — which shares only the honorific — stays
absent. A raw ratio cannot separate those two: they score 0.77 and 0.62 against
the same pool, and no cutoff between them survives adding one more author.
"""

from __future__ import annotations

import unicodedata

from rapidfuzz import fuzz

# Titles, honorifics and initials carry no identity: every Vaiṣṇava teacher is
# some permutation of them. Kept in both scripts because the pool is matched
# across locales. NOTE "swami"/"свами" IS a token of the corpus author's full
# name — stripping it from BOTH sides is what makes the comparison symmetric.
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

# Two spellings of the same name token must survive transliteration drift
# ("Bhaktivinoda" / "Bhaktivinode", "Thakura" / "Ṭhākura" once folded).
_TOKEN_SIMILARITY = 88.0


# Cyrillic → Latin, for comparison only. The published dictionary carries a row
# per locale, so a catalog author matches in either script by lookup. A PRIVATE
# upload has exactly one spelling — whatever the ingest wrote, usually Latin — and
# someone typing «Рохини сута прабху» would never reach "Rohini Suta Prabhu"
# without this. Practical transliteration, not a standard: «прабху» → "prabhu",
# «бхакти» → "bhakti", which is what these names actually look like in Latin.
_CYR_TO_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def _fold(text: str) -> str:
    """Casefold and drop combining marks, so "Ṭhākura" == "thakura"."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _romanize(token: str) -> str:
    """Cyrillic token → Latin, for comparison only.

    Applied per TOKEN, after the initials and honorifics are already gone: some
    letters romanize to two characters («ч» → "ch"), and doing this before the
    single-letter filter would turn the initials of «А. Ч. Бхактиведанта» into
    identity-bearing tokens.
    """
    return "".join(_CYR_TO_LAT.get(c, c) for c in token)


def distinctive_tokens(name: str) -> set[str]:
    """The identity-bearing tokens of `name` — honorifics and single letters
    (initials like "A. C.") removed. Empty when the name is nothing BUT
    honorifics ("Свами"), which denotes no particular teacher."""
    # Hyphens and the rest of the punctuation are SEPARATORS, not letters. The
    # naming convention is full of them — «Rohiṇī-suta», «Bhakti-siddhānta» — and a
    # router that writes "Rohini-suta Prabhu" for a library that stored "Rohini
    # Suta Prabhu" is the same teacher. Left as one token, it matched neither.
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
    """True when every distinctive token of `query` appears in `candidate`.

    Directional on purpose: the query is usually SHORTER than the catalog name
    ("Srila Prabhupada" vs "A. C. Bhaktivedanta Swami Prabhupada"), and naming
    a subset of a teacher's full name means that teacher. The reverse does not
    hold — a query naming someone the candidate doesn't must not match.
    """
    wanted = distinctive_tokens(query)
    if not wanted:
        return False
    have = distinctive_tokens(candidate)
    if not have:
        return False
    if _covers(wanted, have):
        return True
    # Second pass in Latin. The published dictionary holds a row per locale, so a
    # catalog author is reachable in either script by lookup — a PRIVATE upload has
    # one spelling, whatever the ingest wrote, and «Рохини сута прабху» would never
    # reach "Rohini Suta Prabhu" otherwise. Same-script matching runs first so a
    # label still comes back in the script it was asked in.
    return _covers(_romanized(wanted), _romanized(have))


def _covers(wanted: set[str], have: set[str]) -> bool:
    return all(
        any(fuzz.ratio(w, h) >= _TOKEN_SIMILARITY for h in have)
        for w in wanted
    )
