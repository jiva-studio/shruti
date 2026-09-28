"""`domain.text_fold`: accent- and case-insensitive title matching."""

from __future__ import annotations

from shruti_chat.domain.text_fold import fold, matches, tokens


def test_fold_strips_marks_and_case() -> None:
    assert fold("Śrīmad-Bhāgavatam") == "srimad-bhagavatam"
    assert fold("ЁЛКА") == "елка"


def test_tokens_drop_pure_punctuation() -> None:
    assert tokens("Bhagavad — Gītā !") == ["bhagavad", "gita"]
    assert tokens(" -- ") == []


def test_matches_requires_every_query_token_as_a_prefix() -> None:
    title = "Śrīmad Bhāgavatam Canto One"
    assert matches(title, ["sri", "bhag"])
    assert not matches(title, ["sri", "gita"])
    assert matches(title, [])
