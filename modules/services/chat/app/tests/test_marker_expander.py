"""Unit tests for MarkerExpander.

Catches the regression that hit prod 2026-05-20: I told the LLM to emit
`[verse:source_id/tokens|caption]` directly in the prompt, but the
expander only accepts `[verse:N|...]` with integer ref. Result: the
expander silently dropped every verse marker and the user saw empty
gaps where verse cards should have rendered.

Test #1: each marker type — happy path (int ref → expanded), unknown
         ref (logged + dropped), non-integer ref form (dropped).
Test #2: separate file scans every .md prompt for marker examples and
         asserts they parse via the expander's regex set.
"""

from __future__ import annotations

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap


async def _expand(expander: MarkerExpander, text: str) -> str:
    """Feed text fully then drain the tail."""
    fed = await expander.feed(text)
    tail = await expander.flush()
    return fed + tail


# ── cite marker ───────────────────────────────────────────────────────


async def test_cite_int_ref_expands_to_track_id_at_range() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 12_000, 15_000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see this [cite:{ref}|key point].")
    assert out == "see this [cite:track_X@12000-15000|key point]."


async def test_cite_unknown_ref_is_dropped() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "ghost [cite:9999|fabricated] tail")
    assert out == "ghost  tail"


async def test_cite_expanded_form_from_llm_is_dropped() -> None:
    """If the LLM tries to emit the already-expanded form, expander drops it.

    This is the protective behaviour: only the server is allowed to
    write track_id+timespan into the marker — anything the model types
    is treated as a hallucination.
    """
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[cite:track_BG_1972@1000-2000|hallucinated]")
    assert out == ""


# ── verse marker ──────────────────────────────────────────────────────


async def test_verse_int_ref_expands_to_source_id_slash_tokens() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_NoY8sAlXF1IT", "12.5.8", addr_label="ШБ 12.5.8")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"here: [verse:{ref}|ШБ 12.5.8]")
    assert out == "here: [verse:source_NoY8sAlXF1IT/12.5.8|ШБ 12.5.8]"


async def test_verse_unknown_ref_is_dropped() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "before [verse:9999|fake] after")
    assert out == "before  after"


async def test_verse_expanded_form_from_llm_is_dropped() -> None:
    """The exact bug that hit prod — LLM emits source_id/tokens form,
    expander drops it. Verifies we get the right side effect (no output)
    so future prompt drift to this format gets caught immediately."""
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "before [verse:source_X/2.13|БГ 2.13] after")
    assert out == "before  after"


async def test_verse_caption_optional() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("BG", "2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[verse:{ref}]")
    assert out == "[verse:BG/2.13]"


# ── card / outline ───────────────────────────────────────────────────


async def test_card_int_ref_expands_to_track_id() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_track("track_card_X")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[card:{ref}]")
    assert out == "[card:track_card_X]"


async def test_outline_int_ref_expands_to_track_id() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_track("track_outline_X")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[outline:{ref}]")
    assert out == "[outline:track_outline_X]"


# ── pass-through behaviour ───────────────────────────────────────────


async def test_action_marker_passes_through_untouched() -> None:
    """Action markers carry server-issued action_ids; not the expander's job."""
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[action:create_playlist|id=ab12cd34]")
    assert out == "[action:create_playlist|id=ab12cd34]"


async def test_plain_bracketed_text_passes_through() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "see [chapter 1] for details")
    assert out == "see [chapter 1] for details"


async def test_long_buffer_with_no_close_flushes_as_text() -> None:
    """If we open `[` and never see `]`, we eventually flush as plain text."""
    e = MarkerExpander(TurnAliasMap())
    huge = "[" + "x" * 250
    out = await _expand(e, huge)
    assert "x" * 100 in out  # flushed at some point


# ── streaming behaviour ──────────────────────────────────────────────


async def test_marker_split_across_chunks_still_expands() -> None:
    """Real SSE deltas split markers mid-buffer. Expander must reassemble."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_Y", 0, 1000)
    e = MarkerExpander(aliases)
    a = await e.feed(f"text [cite:{ref}")
    b = await e.feed("|cap]")
    tail = await e.flush()
    assert a + b + tail == f"text [cite:track_Y@0-1000|cap]"
