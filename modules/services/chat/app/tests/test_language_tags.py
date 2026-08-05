"""The base-subtag step, shared by two policies that must not merge.

`reduce_locale_to_content_lang` answers "which corpus language does this UI
locale map to" (`uk` → `ru`, no Ukrainian corpus). `_base_lang` answers "which
bucket do I compare in" (`hr` → `sr`, langdetect confuses the continuum). Both
are right; neither should absorb the other.

They shared one step — parsing the tag — written twice, and the copies
disagreed: only one normalised `_` to `-`. So `sr_Latn` reduced to `sr_latn`,
never equalled a detected `sr`, and a correct Serbian answer scored as a
language MISMATCH for any client sending an underscore locale.
"""

from __future__ import annotations

import pytest

from lectorium_chat.domain.language import base_tag
from lectorium_chat.observability.auto_scores import _base_lang
from lectorium_chat.research.pipeline import reduce_locale_to_content_lang


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("sr-Latn", "sr"),
        ("sr_Latn", "sr"),   # the bug: underscores are a real client form
        ("EN_US", "en"),
        ("ru-RU", "ru"),
        ("  ru  ", "ru"),
        ("en", "en"),
    ],
)
def test_base_tag_accepts_both_separators(tag: str, expected: str) -> None:
    assert base_tag(tag) == expected


@pytest.mark.parametrize("empty", ["", None, "   "])
def test_base_tag_returns_empty_for_absence(empty) -> None:
    """Callers decide what absence means rather than being handed a guess."""
    assert base_tag(empty) == ""


def test_the_underscore_locale_now_buckets_correctly() -> None:
    """The regression this fixes: both spellings must reach the same bucket,
    or `language_match` marks a correct answer wrong."""
    assert _base_lang("sr_Latn") == _base_lang("sr-Latn") == "sr"


def test_comparison_bucketing_keeps_its_own_policy() -> None:
    """Folding the Serbo-Croatian continuum belongs to the scorer, not to tag
    parsing — langdetect tagging a Serbian answer `hr` is its problem alone."""
    assert _base_lang("hr") == "sr"
    assert _base_lang("bs") == "sr"
    # ...and it must NOT leak into the content-language reduction.
    assert reduce_locale_to_content_lang("hr") == "en"


def test_content_language_keeps_its_own_policy() -> None:
    """`uk` → `ru` exists because there is no Ukrainian corpus. That is a
    retrieval decision and has no business in a comparison bucket."""
    assert reduce_locale_to_content_lang("uk_UA") == "ru"
    assert _base_lang("uk_UA") == "uk"
