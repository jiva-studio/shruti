"""Unicode-aware text folding for in-memory title search and normalization.

Standard Unicode-folding recipe:
  - NFKD-decompose
  - strip combining marks
  - casefold
"""

from __future__ import annotations

import unicodedata


def fold(s: str) -> str:
    """NFKD-decompose, strip combining marks, casefold."""
    decomposed = unicodedata.normalize("NFKD", s)
    no_marks = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return no_marks.casefold()


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
