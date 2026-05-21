"""Unit tests for MarkerExpander — `[^N]` footnote protocol.

The model emits ONE marker shape — `[^N]` where N is a small
sequential integer from `TurnAliasMap`. Server routes by alias type:

  ChunkRef + start/end → [cite:track@start-end|caption?]   audio
  ChunkRef without start/end → [card:track]                whole-track
  VerseRef                   → [verse:src/tokens|addr_label]  verse card

Captions for audio fragments come from `TurnAliasMap.captions`,
populated by a background Flash-Lite pass. Missing caption → bare
`[cite:track@…]`, no `|`. Graceful degradation.

Defenses against model failure:
  - String-stuffed `[^НП 6]` → single-candidate recovery or drop
  - Legacy `[ref:…]` / `[cite:N]` / `[verse:N]` etc → drop with log
  - Trailing punctuation after marker → server swaps order
"""

from __future__ import annotations

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap


async def _expand(expander: MarkerExpander, text: str) -> str:
    """Feed text fully then drain the tail."""
    fed = await expander.feed(text)
    tail = await expander.flush()
    return fed + tail


# ── [^N] — audio fragment (ChunkRef with start/end) ──────────────────


async def test_footnote_to_lecture_chunk_expands_to_cite() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 12_000, 15_000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see this [^{ref}] tail")
    assert out == "see this [cite:track_X@12000-15000] tail"


async def test_footnote_to_lecture_uses_caption_from_aliases() -> None:
    """Background caption_generator writes into aliases.captions; the
    expander pulls from there when emitting the cite marker."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    aliases.captions[ref] = "духовная энергия"
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}] tail")
    assert out == "text [cite:track_X@0-1000|духовная энергия] tail"


async def test_footnote_without_caption_in_map_emits_bare_cite() -> None:
    """If the bg task hasn't filled the slot, expander degrades to a
    bare `[cite:track@s-e]` — widget renders title + timestamp only."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}]")
    assert out == "[cite:track_X@0-1000]"


# ── [^N] — verse ──────────────────────────────────────────────────────


async def test_footnote_to_verse_expands_to_verse_marker() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_BG", "2.13", addr_label="БГ 2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see [^{ref}] now")
    assert out == "see [verse:source_BG/2.13|БГ 2.13] now"


async def test_footnote_to_verse_no_addr_label() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_BG", "2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}]")
    assert out == "[verse:source_BG/2.13]"


# ── [^N] — whole-track card ──────────────────────────────────────────


async def test_footnote_to_whole_track_expands_to_card() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_track("track_Y")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}]")
    assert out == "[card:track_Y]"


# ── String-stuffed `[^anything-not-integer]` ─────────────────────────


async def test_string_stuffed_footnote_dropped_when_no_unused() -> None:
    """`[^НП 6]` with all aliases emitted → drop silently. Expander
    also collapses the now-orphan whitespace around the dropped
    marker so the prose reads cleanly with a single separator."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^2] [^НП 6] tail")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000] tail"


async def test_string_stuffed_recovered_when_single_unused() -> None:
    """`[^НП 6]` + exactly one unused alias → recovered."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    aliases.alias_chunk("track_C", 0, 1000)   # 3
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^2] [^НП 6]")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000] [cite:track_C@0-1000]"


async def test_string_stuffed_addr_shape_dropped() -> None:
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    aliases.alias_chunk("track_C", 0, 1000)   # 3
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^БГ 2.13]")
    # Two valid aliases unused after [^1] → ambiguous → drop. The
    # trailing whitespace gets swallowed into the dropped marker so
    # the cite ends cleanly.
    assert out == "[cite:track_A@0-1000]"


# ── Single-candidate recovery on numeric hallucination ───────────────


async def test_numeric_hallucination_recovered_when_one_alias_unused() -> None:
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    aliases.alias_chunk("track_C", 0, 1000)   # 3
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^2] [^1022]")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000] [cite:track_C@0-1000]"


async def test_numeric_hallucination_dropped_when_multiple_unused() -> None:
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)
    aliases.alias_chunk("track_B", 0, 1000)
    aliases.alias_chunk("track_C", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] hallucinated [^9999] tail")
    assert out == "[cite:track_A@0-1000] hallucinated tail"


# ── Legacy markers — all dropped ─────────────────────────────────────


async def test_legacy_ref_marker_dropped() -> None:
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, "before [ref:1|cap] after")
    assert out == "before after"


async def test_legacy_cite_marker_dropped() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "text [cite:track_X@0-100|cap] tail")
    assert out == "text tail"


async def test_legacy_verse_marker_dropped() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "text [verse:src/2.13|БГ 2.13] tail")
    assert out == "text tail"


async def test_legacy_card_marker_dropped() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "[card:track_X]")
    assert out == ""


async def test_legacy_outline_marker_dropped() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "[outline:track_X]")
    assert out == ""


async def test_hallucinated_doc_marker_dropped() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "before [commentary:БГ 2.13] after [purport:something] end")
    assert out == "before after end"


# ── Passthrough markers ───────────────────────────────────────────────


async def test_action_marker_passes_through_untouched() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "text [action:create_playlist|id=abc123] tail")
    assert out == "text [action:create_playlist|id=abc123] tail"


async def test_followup_marker_passes_through_untouched() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "text [followup:а что в главе 3?] tail")
    assert out == "text [followup:а что в главе 3?] tail"


async def test_plain_bracketed_text_passes_through() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "see appendix [a] and [b]")
    assert out == "see appendix [a] and [b]"


# ── Buffer / streaming edge cases ─────────────────────────────────────


async def test_long_buffer_with_no_close_flushes_as_text() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    junk = "[" + ("x" * 250)
    out = await _expand(e, junk)
    assert out == junk


async def test_footnote_split_across_chunks_still_expands() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_Y", 0, 1000)
    e = MarkerExpander(aliases)
    a = await e.feed(f"text [^{ref}")
    b = await e.feed("] tail")
    tail = await e.flush()
    assert a + b + tail == "text [cite:track_Y@0-1000] tail"


# ── Placement swap — punctuation BEFORE expanded widget ───────────────


async def test_period_after_marker_gets_swapped_to_before() -> None:
    """LLM emits `Душа вечна [^1].` — server swaps to
    `Душа вечна. [cite:...]` so the period attaches to the prose,
    not floats next to the widget."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"Душа вечна [^{ref}].")
    assert out == "Душа вечна. [cite:track_X@0-1000]"


async def test_comma_after_marker_swapped() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}], more")
    assert out == "text, [cite:track_X@0-1000] more"


async def test_marker_with_trailing_space_then_period_swapped() -> None:
    """The model sometimes writes `text [^1] .` (with stray space) —
    server normalises that too."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}] .")
    assert out == "text. [cite:track_X@0-1000]"


async def test_no_swap_when_next_char_is_letter() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}] more text")
    assert out == "text [cite:track_X@0-1000] more text"


async def test_two_markers_in_a_row_emit_correctly() -> None:
    aliases = TurnAliasMap()
    a = aliases.alias_chunk("track_A", 0, 1000)
    b = aliases.alias_chunk("track_B", 2000, 3000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{a}][^{b}]")
    assert out == "[cite:track_A@0-1000][cite:track_B@2000-3000]"


async def test_marker_at_end_of_stream_flushed_as_is() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}]")
    assert out == "text [cite:track_X@0-1000]"


# ── Server-side dedup (drop 2nd+ occurrence of same alias) ───────────


async def test_duplicate_cite_dropped_keeps_first() -> None:
    """LLM writes `[^1] … [^1]`. First expands, second silently
    dropped — one chip in UI no matter how often the LLM cites it."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"first [^{ref}] middle [^{ref}] tail")
    assert out == "first [cite:track_X@0-1000] middle tail"


async def test_duplicate_verse_dropped() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_BG", "2.13", addr_label="БГ 2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}] then [^{ref}] again")
    assert out == "[verse:source_BG/2.13|БГ 2.13] then again"


async def test_duplicate_adjacent_dropped() -> None:
    """Two markers back-to-back with no separator (UX worst case) —
    the second one drops, leaving a clean single chip."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}][^{ref}]")
    assert out == "[cite:track_X@0-1000]"


async def test_dedup_does_not_block_distinct_aliases() -> None:
    """Different aliases still all render — dedup is per-N."""
    aliases = TurnAliasMap()
    a = aliases.alias_chunk("track_A", 0, 1000)
    b = aliases.alias_chunk("track_B", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{a}] [^{b}] [^{a}]")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000]"


async def test_period_after_dedupped_duplicate_swaps_to_first() -> None:
    """Real prod regression: `text [^1] [^1].` — the dedup drop of
    the second `[^1]` used to immediately commit pending=cite_A,
    so the period landed AFTER the chip instead of swapping. Fix:
    drop doesn't commit pending; the period sees pending and swaps."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}] [^{ref}].")
    assert out == "text. [cite:track_X@0-1000]"


async def test_period_after_dropped_legacy_marker_still_swaps() -> None:
    """`[^1] [ref:legacy].` — legacy marker drop leaves pending intact;
    the period swaps with the first cite."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"text [^{ref}] [ref:legacy].")
    assert out == "text. [cite:track_X@0-1000]"


async def test_dedup_does_not_steal_alias_via_recovery() -> None:
    """A duplicate `[^N]` (already emitted) must NOT trigger the
    single-candidate recovery path — that would silently swap it to
    an unrelated unused alias. Dedup short-circuits before recovery."""
    aliases = TurnAliasMap()
    a = aliases.alias_chunk("track_A", 0, 1000)   # 1
    b = aliases.alias_chunk("track_B", 0, 1000)   # 2
    e = MarkerExpander(aliases)
    # Emit [^1] then [^1] again. Without dedup short-circuit, second
    # [^1] would see "1 is emitted, only 2 unused, single-candidate →
    # recover" — substituting track_B incorrectly. With dedup it just
    # drops.
    out = await _expand(e, f"[^{a}] dup [^{a}] tail")
    assert out == "[cite:track_A@0-1000] dup tail"
    assert "track_B" not in out
