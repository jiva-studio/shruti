"""Tests for message_builder fold logic.

History fold principle (post-tool-leak fix): we feed the LLM only the
user-visible transcript — no integer refs, no track ids, no
source_id/tokens shapes, no widget envelopes. Chip markers collapse to
their caption (or disappear if there was no caption). The per-turn
alias map is no longer round-tripped into the prompt; the current turn
relies on fresh tool_results for grounding.

These tests pin the strip behavior so a future refactor can't silently
re-introduce system-data leakage into the LLM context.
"""

from __future__ import annotations

from shruti_chat.agent.message_builder import (
    _fold_prior_assistant_content,
    fold_history,
)
from shruti_chat.agent.turn_aliases import TurnAliasMap


def test_cite_marker_kept_as_caption() -> None:
    out = _fold_prior_assistant_content(
        "В лекции [cite:track_X@1500-2500|карма последствия] он объясняет.",
        None,
    )
    assert "карма последствия" in out
    # No internal identifiers — caption only.
    assert "track_X" not in out
    assert "[cite:" not in out
    assert "1500" not in out


def test_verse_marker_kept_as_caption() -> None:
    out = _fold_prior_assistant_content(
        "Стих [verse:source_BG/2.13|БГ 2.13] раскрывает тему.",
        None,
    )
    assert "БГ 2.13" in out
    assert "source_BG" not in out
    assert "[verse:" not in out


def test_verse_marker_compound_tokens() -> None:
    """Compound verses use comma-separated tokens like 1.2.28,1.2.29."""
    out = _fold_prior_assistant_content(
        "Стих [verse:source_SB/1.2.28,1.2.29|ШБ 1.2.28-29] говорит...",
        None,
    )
    assert "ШБ 1.2.28-29" in out
    assert "source_SB" not in out


def test_verse_marker_without_caption_disappears() -> None:
    """No caption → the marker just vanishes (it was a widget-only chip)."""
    out = _fold_prior_assistant_content("См. [verse:source_SB/5.5.3] контекст.", None)
    assert "source_SB" not in out
    assert "[verse:" not in out
    assert "См." in out
    assert "контекст" in out


def test_card_and_outline_markers_dropped() -> None:
    """Card / outline render as widgets in the bubble — they have no
    text equivalent the user reads. Drop them entirely in fold."""
    out = _fold_prior_assistant_content(
        "Вот трек: [card:track_ABC]\nИ оглавление: [outline:track_ABC]",
        None,
    )
    assert "track_ABC" not in out
    assert "[card:" not in out
    assert "[outline:" not in out
    assert "Вот трек" in out
    assert "И оглавление" in out


def test_action_marker_dropped() -> None:
    out = _fold_prior_assistant_content(
        "Готов плейлист. [action:create_playlist|id=ab12cd34]",
        None,
    )
    assert "action:" not in out
    assert "ab12cd34" not in out
    assert "Готов плейлист" in out


def test_followup_marker_dropped() -> None:
    out = _fold_prior_assistant_content(
        "Готово.\n[followup:Расскажи ещё]\n[followup:Покажи лекции]",
        None,
    )
    assert "followup:" not in out
    assert "Расскажи" not in out
    assert "Готово" in out


def test_tool_protocol_leak_stripped_from_fold_history() -> None:
    """If a past turn's response leaked `[tool_use]/[tool_result]`
    envelopes (Gemini Flash Lite mimicry bug), feeding them back in
    history reinforces the mimicry. fold_history must strip them so
    fresh turns can't see the trigger pattern."""
    leaked = (
        "[tool_use] chunks_search(query=\"карма\", type=\"lecture\")\n"
        "[tool_result]\n"
        "[{\"type\": \"lecture\", \"ref\": 7882, \"label\": \"L1\"}]\n"
        "\n"
        "Прабхупада объясняет, что карма ведёт к последствиям."
    )
    out = fold_history([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": leaked},
    ])
    folded = out[1]["content"]
    assert "[tool_use]" not in folded
    assert "[tool_result]" not in folded
    assert '"type"' not in folded
    # Legitimate prose survives the strip.
    assert "карма" in folded


def test_aliases_payload_ignored_by_fold() -> None:
    """`aliases` on a history entry used to be round-tripped into
    integer refs. We no longer do that — the field is accepted (for
    backward compat with persisted messages) but ignored."""
    a = TurnAliasMap()
    a.alias_chunk("track_A", 100, 200)
    out = fold_history([
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": "answer [cite:track_A@100-200|caption1]",
            "aliases": a.serialize(),
        },
    ])
    folded = out[1]["content"]
    assert "caption1" in folded
    assert "track_A" not in folded
    # No integer ref slipped in.
    assert "[cite:" not in folded


# ── fold_history public helper ───────────────────────────────────────────


def test_fold_history_empty_returns_empty_list() -> None:
    assert fold_history([]) == []


def test_fold_history_drops_malformed_entries() -> None:
    """Missing role / missing content / unknown role → silently dropped."""
    out = fold_history(
        [
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "should be ignored"},  # not user/assistant
            {"role": "user"},                                     # missing content
            {"role": "user", "content": ""},                      # empty content
            {"role": "assistant", "content": "hello"},
        ]
    )
    assert out == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
