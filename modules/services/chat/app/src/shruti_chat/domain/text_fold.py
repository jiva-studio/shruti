"""Unicode-aware text folding, the one used for every accent- and
case-insensitive comparison: title search and teacher-name matching alike.

Recipe: NFKD-decompose, drop combining marks, casefold. "Combining" is the
canonical combining class, not the general category: accents and dots over
Latin and Cyrillic letters go ("Ṭhākura" == "thakura", "Ёлка" == "елка"),
while an Indic vowel sign — a letter of its own, with class 0 — stays.
"""

from __future__ import annotations

import unicodedata


def fold(s: str) -> str:
    """NFKD-decompose, drop combining marks, casefold."""
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def tokens(s: str) -> list[str]:
    """Fold + split into alnum-bearing tokens. Empty on no signal."""
    folded = fold(s)
    return [t for t in folded.split() if any(c.isalnum() for c in t)]


def matches(title: str, query_tokens: list[str]) -> bool:
    """`title` (already folded) contains every `query_tokens` element as
    a prefix in any token. Empty `query_tokens` -> True."""
    if not query_tokens:
        return True
    folded_title_tokens = fold(title).split()
    for q in query_tokens:
        if not any(t.startswith(q) for t in folded_title_tokens):
            return False
    return True
