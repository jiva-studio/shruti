"""Tests for `agent.prior_refs.extract_prior_track_refs`."""

from __future__ import annotations

from lectorium_chat.agent.prior_refs import extract_prior_track_refs


def test_returns_empty_when_no_history() -> None:
    assert extract_prior_track_refs(None) == []
    assert extract_prior_track_refs([]) == []


def test_returns_empty_when_no_assistant_message() -> None:
    history = [{"role": "user", "content": "что такое разум"}]
    assert extract_prior_track_refs(history) == []


def test_extracts_card_track_ids() -> None:
    history = [
        {"role": "user", "content": "собери плейлист про карму"},
        {
            "role": "assistant",
            "content": (
                "Вот несколько лекций:\n"
                "[card:track_AAAA]\n"
                "[card:track_BBBB]\n"
                "[card:track_CCCC]"
            ),
        },
    ]
    assert extract_prior_track_refs(history) == [
        "track_AAAA",
        "track_BBBB",
        "track_CCCC",
    ]


def test_extracts_cite_track_ids() -> None:
    history = [
        {"role": "user", "content": "что такое разум"},
        {
            "role": "assistant",
            "content": (
                "Прабхупада объясняет [cite:track_X1@1000-2000|разум] "
                "и связь с буддхи-йогой [cite:track_X2@5000-6000|буддхи]."
            ),
        },
    ]
    assert extract_prior_track_refs(history) == ["track_X1", "track_X2"]


def test_dedupes_same_track_seen_twice() -> None:
    """A single lecture can be cited as both card AND cite — dedupe."""
    history = [
        {
            "role": "assistant",
            "content": (
                "[card:track_X]\n"
                "with quote [cite:track_X@1000-2000|fragment]"
            ),
        },
    ]
    assert extract_prior_track_refs(history) == ["track_X"]


def test_only_reads_last_assistant_message() -> None:
    """Earlier assistant turns are ignored — only the most recent
    chat bubble is referenced by deictic phrases like «этих лекций»."""
    history = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "[card:track_OLD]"},
        {"role": "user", "content": "q2"},
        {"role": "assistant", "content": "[card:track_RECENT]"},
    ]
    assert extract_prior_track_refs(history) == ["track_RECENT"]


def test_ignores_other_marker_kinds() -> None:
    """verse / action / followup markers are not track-shaped."""
    history = [
        {
            "role": "assistant",
            "content": (
                "[verse:source_BG/2.13|БГ 2.13] "
                "[action:share_pdf|id=abc] "
                "[followup:тапни] "
                "[card:track_OK]"
            ),
        },
    ]
    assert extract_prior_track_refs(history) == ["track_OK"]


def test_handles_dots_dashes_underscores_in_ids() -> None:
    history = [
        {
            "role": "assistant",
            "content": "[card:track_AB-12.3] [cite:track_X_Y@0-100]",
        },
    ]
    assert extract_prior_track_refs(history) == [
        "track_AB-12.3",
        "track_X_Y",
    ]


def test_preserves_document_order() -> None:
    history = [
        {
            "role": "assistant",
            "content": (
                "[cite:track_B@0-100] then "
                "[card:track_A] then "
                "[card:track_C]"
            ),
        },
    ]
    assert extract_prior_track_refs(history) == [
        "track_B",
        "track_A",
        "track_C",
    ]
