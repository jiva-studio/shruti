"""Unit tests for `annotate_markers` — the human-readable expansion
inlined under chip markers in the Langfuse trace output.

Verifies the trace-only rewrite resolves cite / commentary markers
against the per-turn alias map, mirrors what the user saw (translated
purport sentences when present), and leaves the marker itself verbatim.
"""

from __future__ import annotations

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.observability.marker_annotations import (
    _fmt_ms,
    annotate_markers,
)


def test_fmt_ms():
    assert _fmt_ms(552480) == "9:12"
    assert _fmt_ms(0) == "0:00"
    assert _fmt_ms(3723000) == "1:02:03"


def test_cite_marker_expands_with_transcript_snippet():
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_eV6bWmyLYcPD", 552480, 607280, lang="en")
    aliases.chunk_texts[n] = "The living entity, being marginal, can come under the influence of maya."

    text = "Some prose. [cite:track_eV6bWmyLYcPD@552480-607280] More prose."
    out = annotate_markers(text, aliases)

    # Marker stays verbatim …
    assert "[cite:track_eV6bWmyLYcPD@552480-607280]" in out
    # … followed by the window and the transcript snippet, then a close tag.
    assert "9:12–10:07" in out
    assert "The living entity, being marginal" in out
    assert "[/cite]" in out
    # Prose after the citation resumes on its own line, not glued to [/cite].
    assert "[/cite]\n" in out
    assert "[/cite] More prose" not in out


def test_cite_without_stashed_text_shows_window_only():
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_X", 1000, 2000, lang="en")  # no chunk_texts entry

    out = annotate_markers("[cite:track_X@1000-2000]", aliases)
    assert "0:01–0:02" in out
    assert "[/cite]" in out


def test_commentary_uses_translated_sentences_when_present():
    aliases = TurnAliasMap()
    n = aliases.alias_commentary(
        "item_1",
        0,
        addr_label="ШБ 1.7.5",
        author_name="Prabhupada",
        sentences=["Jaya and Vijaya fell from Vaikuntha."],
    )
    aliases.set_commentary_translation(
        n,
        sentences_translated=("Джая и Виджая пали с Вайкунтхи.",),
        mt=True,
    )

    out = annotate_markers(f"text [commentary:{n}] text", aliases)
    assert f"[commentary:{n}]" in out
    assert "ШБ 1.7.5" in out
    assert "Prabhupada" in out
    # Mirrors what the user saw — the translated sentence, not the source.
    assert "Джая и Виджая пали" in out
    assert "Jaya and Vijaya" not in out
    assert "[/commentary]" in out


async def test_commentary_shows_only_picked_sentences_in_card_mode():
    """End-to-end: the card-mode expander stashes the rendered quote
    (picked sentences only), and the annotation shows exactly that —
    not the whole chunk body."""
    aliases = TurnAliasMap()
    n = aliases.alias_commentary(
        "item_1",
        0,
        addr_label="ШБ 1.7.5",
        author_name="Prabhupada",
        sentences=[
            "First sentence the model skipped.",
            "Second picked sentence.",
            "Third sentence the model skipped.",
            "Fourth picked sentence.",
        ],
    )
    expander = MarkerExpander(aliases, commentary_as_card=True)
    fed = await expander.feed(f"prose [^{n}|s=1,3] tail")
    fed += await expander.flush()

    # The expander emitted the numeric card marker and stashed the picks.
    assert f"[commentary:{n}]" in fed
    # Non-consecutive picks (1, 3) join with ` … ` — same as the card.
    assert aliases.commentary_shown[n] == "Second picked sentence. … Fourth picked sentence."

    out = annotate_markers(fed, aliases)
    assert "Second picked sentence." in out
    assert "Fourth picked sentence." in out
    # The un-picked sentences must NOT leak into the trace expansion.
    assert "First sentence the model skipped." not in out
    assert "Third sentence the model skipped." not in out


def test_commentary_falls_back_to_source_sentences():
    aliases = TurnAliasMap()
    n = aliases.alias_commentary(
        "item_1", 0, addr_label="BG 2.13", author_name=None,
        sentences=["The soul is eternal."],
    )
    out = annotate_markers(f"[commentary:{n}]", aliases)
    assert "The soul is eternal." in out
    assert "BG 2.13" in out


def test_unknown_marker_left_untouched():
    aliases = TurnAliasMap()
    # Alias 99 was never minted → resolve returns None → marker unchanged.
    text = "[commentary:99]"
    assert annotate_markers(text, aliases) == text


def test_no_markers_is_identity():
    aliases = TurnAliasMap()
    text = "Just plain prose with no markers at all."
    assert annotate_markers(text, aliases) == text


def test_empty_text():
    assert annotate_markers("", TurnAliasMap()) == ""
