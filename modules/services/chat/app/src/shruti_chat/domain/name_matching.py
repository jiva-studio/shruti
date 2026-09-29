"""Whether a written-out person's name denotes a stored one, and which row.

A name is folded, split on punctuation, and stripped of single letters
(initials) and of the titles its naming conventions declare; what remains are
its distinctive tokens. A query denotes a candidate when every distinctive token
of the query is close to one of the candidate's. The rule is directional: a
query may name a subset of a full name, never more than it.

Tokens are compared as written first, then romanized by the conventions, so a
name typed in one script reaches a name stored in only another. What counts as
a title and how a script is romanized is not decided here: each naming
convention is a strategy registered by the composition root. With none, names
are compared on their folded tokens alone.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Protocol, TypeVar

from rapidfuzz import fuzz

from shruti_chat.domain.text_fold import fold

# Punctuation that separates the parts of a name rather than belonging to one.
_SEPARATORS = ".,-–—‑'\"()/"

# Two spellings of one token must survive transliteration drift.
_TOKEN_SIMILARITY = 88.0


class NameConvention(Protocol):
    """How one naming tradition writes names.

    `titles` are the folded tokens that carry no identity. `romanize` spells one
    folded token in Latin, returning a token of another script unchanged; it
    runs after titles and initials are dropped.
    """

    @property
    def titles(self) -> frozenset[str]: ...

    def romanize(self, token: str) -> str: ...


class Named(Protocol):
    @property
    def full_name(self) -> str: ...


N = TypeVar("N", bound=Named)


class NameMatcher:
    """The matching rule, parameterised by the registered naming conventions."""

    def __init__(self, conventions: Sequence[NameConvention] = ()) -> None:
        self._conventions = tuple(conventions)
        self._titles: frozenset[str] = frozenset().union(
            *(c.titles for c in self._conventions)
        )

    def distinctive_tokens(self, name: str) -> set[str]:
        """The identity-bearing tokens of `name`; empty when it has none."""
        folded = fold(name)
        for ch in _SEPARATORS:
            folded = folded.replace(ch, " ")
        return {t for t in folded.split() if len(t) > 1 and t not in self._titles}

    def names_match(self, query: str, candidate: str) -> bool:
        """True when `query` denotes `candidate`, as written or romanized."""
        wanted = self.distinctive_tokens(query)
        have = self.distinctive_tokens(candidate)
        if not wanted or not have:
            return False
        if _covers(wanted, have):
            return True
        return _covers(self._romanized(wanted), self._romanized(have))

    def select(self, name: str, candidates: Iterable[N]) -> N | None:
        """The first candidate `name` denotes in its own script, else the first
        it denotes once romanized, so a name comes back in the script asked."""
        pool = list(candidates)
        wanted = self.distinctive_tokens(name)
        if not wanted:
            return None
        for candidate in pool:
            have = self.distinctive_tokens(candidate.full_name)
            if have and _covers(wanted, have):
                return candidate
        for candidate in pool:
            if self.names_match(name, candidate.full_name):
                return candidate
        return None

    def _romanized(self, tokens: set[str]) -> set[str]:
        return {self._romanize(t) for t in tokens}

    def _romanize(self, token: str) -> str:
        for convention in self._conventions:
            token = convention.romanize(token)
        return token


def _covers(wanted: set[str], have: set[str]) -> bool:
    return all(
        any(fuzz.ratio(w, h) >= _TOKEN_SIMILARITY for h in have)
        for w in wanted
    )
