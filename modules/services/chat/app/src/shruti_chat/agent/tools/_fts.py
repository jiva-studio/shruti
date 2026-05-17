"""Unicode-aware text folding for in-memory title search.

We can't lean on the catalog's FTS4 index for accent-insensitive title
match: SQLite's `unicode61 remove_diacritics=2` normalises Latin
diacritics on the index side but leaves Cyrillic ё/й as-is, which makes
a Python-side `casefold()` of the query asymmetric with what FTS stores.
Rebuilding the index is a content-db-builder concern, not a chat-agent
one.

Instead, `list_tracks(title_query=...)` does an in-memory scan over
`track_variants.title` with the same `fold()` applied to both sides.
~10k rows is microseconds in Python — well below FTS overhead anyway.
"""

from __future__ import annotations

import unicodedata


def fold(s: str) -> str:
    """NFKD-decompose, strip combining marks, casefold.

    Standard Unicode-folding recipe — symmetric folding of:
      - Latin diacritics: «café» ↔ «cafe»
      - Cyrillic ё/й (NFKD decomposes them to е/и + combining mark)
      - Greek/Hebrew/Arabic combining marks
      - any other decomposable Unicode
    `casefold` (not `lower`) is the locale-correct lowercaser —
    e.g. Turkish dotted-I → i.
    """
    decomposed = unicodedata.normalize("NFKD", s)
    no_marks = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return no_marks.casefold()


def tokens(s: str) -> list[str]:
    """Fold + split into alnum-bearing tokens. Empty on no signal."""
    folded = fold(s)
    return [t for t in folded.split() if any(c.isalnum() for c in t)]


def matches(title: str, query_tokens: list[str]) -> bool:
    """`title` (already folded) contains every `query_tokens` element as
    a prefix in any token. Empty `query_tokens` → True (caller should
    short-circuit before calling)."""
    if not query_tokens:
        return True
    folded_title_tokens = fold(title).split()
    for q in query_tokens:
        if not any(t.startswith(q) for t in folded_title_tokens):
            return False
    return True
