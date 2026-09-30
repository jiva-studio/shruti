"""The generic name matcher and its extension points.

With no naming convention registered a name is compared on its folded tokens
alone; a convention adds titles to drop and a romanization, and several compose.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from structlog.testing import capture_logs

from shruti_chat.application.author_lookup import resolve_author
from shruti_chat.domain.name_matching import NameMatcher


def test_a_matcher_cannot_be_built_without_naming_conventions() -> None:
    with pytest.raises(TypeError, match="conventions"):
        NameMatcher()  # type: ignore[call-arg]


def test_without_conventions_every_token_but_initials_is_distinctive() -> None:
    matcher = NameMatcher(())
    assert matcher.distinctive_tokens("Dr. J. R. R. Tolkien-Smith") == {"dr", "tolkien", "smith"}
    assert matcher.names_match("Tolkien", "J. R. R. Tolkien")
    assert matcher.names_match("tolkíen", "J. R. R. Tolkien")
    assert not matcher.names_match("Dr Tolkien", "J. R. R. Tolkien")
    assert not matcher.names_match("Толкин", "J. R. R. Tolkien")


@dataclass(frozen=True)
class _Titles:
    titles: frozenset[str]

    def romanize(self, token: str) -> str:
        return token


@dataclass(frozen=True)
class _Greek:
    titles: frozenset[str] = frozenset({"κυρια"})

    def romanize(self, token: str) -> str:
        return token.translate(str.maketrans("τολκιεν", "tolkien"))


def test_a_conventions_titles_carry_no_identity() -> None:
    matcher = NameMatcher([_Titles(frozenset({"dr", "prof"}))])
    assert matcher.distinctive_tokens("Prof. Dr. Tolkien") == {"tolkien"}
    assert matcher.names_match("Dr Tolkien", "J. R. R. Tolkien")
    assert matcher.distinctive_tokens("Prof. Dr.") == set()
    assert not matcher.names_match("Prof. Dr.", "Prof. Dr. Tolkien")


def test_conventions_compose() -> None:
    matcher = NameMatcher([_Titles(frozenset({"dr"})), _Greek()])
    assert matcher.distinctive_tokens("Κυρία Dr Τόλκιεν") == {"τολκιεν"}
    assert matcher.names_match("Κυρία Τόλκιεν", "Dr J. R. R. Tolkien")


@dataclass
class _Row:
    id: str
    full_name: str


def test_select_prefers_the_asked_script_then_the_romanized_one() -> None:
    matcher = NameMatcher([_Greek()])
    latin, greek = _Row("en", "Tolkien"), _Row("el", "Τόλκιεν")
    assert matcher.select("Τόλκιεν", [latin, greek]) is greek
    assert matcher.select("Τόλκιεν", [latin]) is latin
    assert matcher.select("Κυρία", [latin, greek]) is None


class _Unreachable:
    async def resolve(self, kind, text, *, lang, limit):
        raise RuntimeError("catalog gone")


async def test_an_unreachable_catalog_is_logged_and_finds_nobody() -> None:
    with capture_logs() as logs:
        hit = await resolve_author(NameMatcher(()), _Unreachable(), "Tolkien", request_id="r1")
    assert hit is None
    assert [e for e in logs if e["event"] == "author_resolve_failed"] == [
        {
            "event": "author_resolve_failed",
            "log_level": "warning",
            "request_id": "r1",
            "name": "Tolkien",
            "error": "catalog gone",
        },
    ]
