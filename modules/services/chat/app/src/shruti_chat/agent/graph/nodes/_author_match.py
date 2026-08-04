"""Does a teacher's name, as the ROUTER wrote it, denote a corpus author?

The router normalizes the speaker it extracts to English ("Шрила Прабхупада" →
"Srila Prabhupada"), so a name can never be compared against one locale's
dictionary alone: a Latin query scores ~0.04 against the Cyrillic
"А. Ч. Бхактиведанта Свами Прабхупада" and the corpus's OWN author reads as
absent. Callers therefore resolve across ALL locales and decide here.

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


def _fold(text: str) -> str:
    """Casefold and drop combining marks, so "Ṭhākura" == "thakura"."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def distinctive_tokens(name: str) -> set[str]:
    """The identity-bearing tokens of `name` — honorifics and single letters
    (initials like "A. C.") removed. Empty when the name is nothing BUT
    honorifics ("Свами"), which denotes no particular teacher."""
    folded = _fold(name).replace(".", " ").replace(",", " ")
    return {
        t for t in folded.split()
        if len(t) > 1 and t not in _HONORIFICS
    }


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
    return all(
        any(fuzz.ratio(w, h) >= _TOKEN_SIMILARITY for h in have)
        for w in wanted
    )
