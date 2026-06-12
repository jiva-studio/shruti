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
  - String-stuffed / hallucinated `[^НП 6]` / `[^1022]` → drop (never
    guessed back to a source)
  - Duplicate `[^N]` (same alias twice in a response) → drop 2nd+
  - Trailing punctuation after marker → server swaps order
"""

from __future__ import annotations

from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.turn_aliases import TurnAliasMap


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


# ── [^N] — media clip ────────────────────────────────────────────────


async def test_footnote_to_media_expands_to_media_marker() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_media(
        "media_abc", label="Хари Шаури · 1976", text="Я помню...",
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see [^{ref}] now")
    assert out == "see [media:media_abc|Хари Шаури · 1976] now"


async def test_footnote_to_media_no_label() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_media("media_x", label="")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}]")
    assert out == "[media:media_x]"


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


async def test_string_stuffed_marker_dropped_never_recovered() -> None:
    """`[^НП 6]` is unresolvable → drop it, even if exactly one alias is
    unused. We no longer guess the source from a single remaining
    candidate (the old single-candidate recovery); a missing chip beats a
    confidently-wrong one."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    aliases.alias_chunk("track_C", 0, 1000)   # 3
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^2] [^НП 6]")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000]"


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


# ── Numeric hallucination is always dropped, never recovered ─────────


async def test_numeric_hallucination_dropped_when_one_alias_unused() -> None:
    """An invented numeric ref (`[^1022]`) is dropped even when exactly
    one alias remains unused. The sequential 1..K allocation removed the
    root cause that single-candidate recovery used to paper over, so the
    guess is no longer worth its mis-attribution risk."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)   # 2
    aliases.alias_chunk("track_C", 0, 1000)   # 3
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] [^2] [^1022]")
    assert out == "[cite:track_A@0-1000] [cite:track_B@0-1000]"


async def test_numeric_hallucination_dropped_when_multiple_unused() -> None:
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_A", 0, 1000)
    aliases.alias_chunk("track_B", 0, 1000)
    aliases.alias_chunk("track_C", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, "[^1] hallucinated [^9999] tail")
    assert out == "[cite:track_A@0-1000] hallucinated tail"


# ── Passthrough markers ───────────────────────────────────────────────


async def test_action_marker_passes_through_untouched() -> None:
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases)
    out = await _expand(e, "text [action:share_pdf|id=abc123] tail")
    assert out == "text [action:share_pdf|id=abc123] tail"


async def test_action_marker_kept_when_id_was_emitted() -> None:
    """With a validation set, a marker whose id actually fired this turn
    survives verbatim."""
    aliases = TurnAliasMap()
    emitted = {"abc123"}
    e = MarkerExpander(aliases, emitted_action_ids=emitted)
    out = await _expand(e, "Готовлю PDF. [action:share_pdf|id=abc123]")
    assert out == "Готовлю PDF. [action:share_pdf|id=abc123]"


async def test_orphan_action_marker_dropped_when_id_never_emitted() -> None:
    """A grammar-valid action marker whose id was NOT emitted as a real
    action event this turn is a hallucination — dropped so the client
    never renders «Карточка повреждена»."""
    aliases = TurnAliasMap()
    emitted: set[str] = set()  # no propose_*/pdf tool fired
    e = MarkerExpander(aliases, emitted_action_ids=emitted)
    out = await _expand(e, "Готово. [action:share_pdf|id=deadbeef] спасибо")
    # Marker gone; surrounding prose intact (leading ws before the dropped
    # marker is discarded by the same normalisation as other drops).
    assert "[action:" not in out
    assert "deadbeef" not in out
    assert out.startswith("Готово.")
    assert out.rstrip().endswith("спасибо")
    assert e.malformed_count == 1


async def test_orphan_action_marker_dropped_with_real_one_kept() -> None:
    """Mixed turn: one real action id and one hallucinated id. Keep the
    real, drop the orphan."""
    aliases = TurnAliasMap()
    emitted = {"real0001"}
    e = MarkerExpander(aliases, emitted_action_ids=emitted)
    out = await _expand(
        e,
        "[action:share_pdf|id=real0001] [action:upgrade_to_pro|id=fake9999]",
    )
    assert "[action:share_pdf|id=real0001]" in out
    assert "fake9999" not in out
    assert "[action:upgrade_to_pro" not in out


async def test_action_marker_no_validation_set_passes_through() -> None:
    """Legacy / test path with no validation set — grammar-valid action
    markers pass through unchanged regardless of id."""
    aliases = TurnAliasMap()
    e = MarkerExpander(aliases, emitted_action_ids=None)
    out = await _expand(e, "x [action:share_pdf|id=whatever] y")
    assert out == "x [action:share_pdf|id=whatever] y"


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


async def test_duplicate_ref_dropped_never_reassigned() -> None:
    """A duplicate `[^N]` (already emitted) is dropped, never swapped to
    a different unused alias. (Recovery that could have done such a swap
    is gone, but the dedup-drop guarantee is load-bearing on its own.)"""
    aliases = TurnAliasMap()
    a = aliases.alias_chunk("track_A", 0, 1000)   # 1
    aliases.alias_chunk("track_B", 0, 1000)       # 2 (must never be stolen)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{a}] dup [^{a}] tail")
    assert out == "[cite:track_A@0-1000] dup tail"
    assert "track_B" not in out


# ── [^N|s=...] — commentary blockquote (CommentaryRef) ───────────────


async def test_commentary_marker_nonconsecutive_picks_joined_with_ellipsis() -> None:
    """Non-consecutive picks (s=0,2 skips 1) join on ONE line with ` … `
    between runs. Avoids the old shape of each sentence as a separate `>`
    line, which rendered as a list."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "comm_xyz", 0,
        addr_label="БГ 2.13",
        author_name="А.Ч. Бхактиведанта Свами Прабхупада",
        sentences=["Sentence ZERO.", "Sentence ONE.", "Sentence TWO."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"prose [^{ref}|s=0,2]\n")
    # Both picked sentences land on ONE blockquote line, separated by ` … `
    # since indices 0 and 2 are non-consecutive.
    assert "> Sentence ZERO. … Sentence TWO." in out
    assert "> Sentence ONE." not in out
    # Picked sentences must not be on separate `> ` lines.
    assert "> Sentence ZERO.\n> Sentence TWO." not in out
    assert "— А.Ч. Бхактиведанта Свами Прабхупада, БГ 2.13" in out


async def test_commentary_marker_consecutive_picks_joined_with_space() -> None:
    """Consecutive picks (s=0,1,2) join with a single space — they're
    adjacent in the source, so they read as one continuous thought."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="БГ 2.13", author_name="Author",
        sentences=["S0.", "S1.", "S2.", "S3."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}|s=0,1,2]")
    assert "> S0. S1. S2." in out
    # No ellipsis since runs are consecutive.
    assert " … " not in out


async def test_commentary_marker_mixed_consecutive_and_gap_two_runs() -> None:
    """s=0,1,3,4 → two consecutive runs (0,1 and 3,4) joined within with
    spaces, runs separated by ` … `."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="БГ 2.13", author_name="Author",
        sentences=["S0.", "S1.", "S2.", "S3.", "S4."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}|s=0,1,3,4]")
    assert "> S0. S1. … S3. S4." in out
    assert "> S2." not in out


async def test_commentary_marker_out_of_order_indices_sorted_before_join() -> None:
    """LLM may emit indices out of order (s=2,0,1); renderer sorts first
    so the joined output reads natural-order."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="БГ 2.13", author_name="Author",
        sentences=["S0.", "S1.", "S2."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}|s=2,0,1]")
    assert "> S0. S1. S2." in out


async def test_commentary_marker_without_s_defaults_to_first_two_joined() -> None:
    """Fallback (no `|s=...`) picks indices 0,1 — consecutive, so joined
    with a single space on one line."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="БГ 2.13", author_name="Author",
        sentences=["S0.", "S1.", "S2.", "S3."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}]")
    assert "> S0. S1." in out
    assert "> S2." not in out


async def test_commentary_marker_out_of_range_indices_drop_silently() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="БГ 2.13", author_name=None,
        sentences=["only one"],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}|s=99]")
    # All requested indices invalid → empty expansion (better than fake quote).
    assert "only one" not in out
    assert ">" not in out


async def test_s_suffix_on_lecture_alias_is_silently_ignored() -> None:
    """`|s=...` on a non-commentary ref must NOT break the cite — server
    ignores the suffix and expands lecture as normal."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see [^{ref}|s=0,1] here")
    assert out == "see [cite:track_X@0-1000] here"


# ── Commentary CARD mode (client declared `commentary_card`) ─────────


async def test_commentary_card_mode_emits_numeric_marker_and_action() -> None:
    """With `commentary_as_card`, the expander emits `[commentary:N]` (just
    the number) and queues an `action` payload carrying ONLY the cited
    sentences + author + reference — the audio-citation shape. No blockquote
    text leaks into the delta."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "comm_xyz", 3,
        addr_label="БГ 2.13",
        author_name="Прабхупада",
        sentences=["S0.", "S1.", "S2.", "S3."],
    )
    e = MarkerExpander(aliases, commentary_as_card=True)
    out = await _expand(e, f"prose [^{ref}|s=0,2] tail.")
    # Marker is the bare number; no quote text in the delta.
    assert f"[commentary:{ref}]" in out
    assert "S0." not in out and "S2." not in out and ">" not in out
    # The quote rides the queued action payload (the SSE body).
    actions = e.take_commentary_actions()
    assert len(actions) == 1
    payload = actions[0]["data"]["payload"]
    assert actions[0]["data"]["kind"] == "commentary"
    assert payload["ref"] == ref
    assert payload["text"] == "S0. … S2."  # only the cited sentences
    assert payload["author_name"] == "Прабхупада"
    assert payload["addr_label"] == "БГ 2.13"
    assert "mt" not in payload  # not translated


async def test_commentary_card_mode_ships_original_when_translated() -> None:
    """When the purport is machine-translated, the action carries the shown
    (translated) quote as `text` and the verbatim original as
    `text_original` + `mt: True` — index-aligned to the same picks."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="BG 2.13", author_name="Author",
        sentences=["Orig zero.", "Orig one.", "Orig two."],
    )
    aliases.set_commentary_translation(
        ref, sentences_translated=("Пер ноль.", "Пер один.", "Пер два."), mt=True
    )
    e = MarkerExpander(aliases, commentary_as_card=True)
    await _expand(e, f"[^{ref}|s=0,2]")
    payload = e.take_commentary_actions()[0]["data"]["payload"]
    assert payload["text"] == "Пер ноль. … Пер два."
    assert payload["text_original"] == "Orig zero. … Orig two."
    assert payload["mt"] is True


async def test_commentary_card_mode_off_keeps_blockquote_no_action() -> None:
    """Default (no capability) is byte-identical to before: inline
    blockquote, no queued action."""
    aliases = TurnAliasMap()
    ref = aliases.alias_commentary(
        "c", 0, addr_label="BG 2.13", author_name="Author",
        sentences=["S0.", "S1."],
    )
    e = MarkerExpander(aliases)  # card mode off
    out = await _expand(e, f"[^{ref}|s=0,1]")
    assert "> S0. S1." in out
    assert "[commentary:" not in out
    assert e.take_commentary_actions() == []


# ── Lazy verse cards (card clients emit at synth time) ───────────────


async def test_lazy_verse_queues_request_and_keeps_marker() -> None:
    """With `lazy_verse`, expanding a verse `[^N]` still emits the
    `[verse:…]` marker AND queues the VerseRef for synth-time build/emit."""
    aliases = TurnAliasMap()
    n = aliases.alias_verse("source_BG", "2.13", addr_label="BG 2.13")
    e = MarkerExpander(aliases, lazy_verse=True)
    out = await _expand(e, f"see [^{n}].")
    assert "[verse:source_BG/2.13|BG 2.13]" in out
    reqs = e.take_verse_requests()
    assert len(reqs) == 1
    assert (reqs[0].source_id, reqs[0].tokens) == ("source_BG", "2.13")
    assert e.take_verse_requests() == []  # drained


async def test_no_verse_requests_without_lazy_flag() -> None:
    """Legacy mode (eager flush owns verse payloads): the expander queues
    nothing; the marker is unchanged."""
    aliases = TurnAliasMap()
    n = aliases.alias_verse("source_BG", "2.13", addr_label="BG 2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see [^{n}].")
    assert "[verse:source_BG/2.13|BG 2.13]" in out
    assert e.take_verse_requests() == []


# ── Adjacent commentary blockquotes — merge or separate ──────────────


async def test_two_adjacent_same_source_commentary_markers_merge() -> None:
    """Two `[^N|s=…]` for different aliases pointing to the SAME
    (author, addr_label) must produce ONE merged blockquote — not two
    glued ones with duplicate attribution lines. The merged picks render
    on ONE blockquote line (per the new join policy) with attribution
    appearing exactly once at the end."""
    aliases = TurnAliasMap()
    ref_a = aliases.alias_commentary(
        "comm_seg0", 0,
        addr_label="БГ 18.66", author_name="А.Ч. Прабхупада",
        sentences=["First sentence.", "Second sentence.", "Third."],
    )
    ref_b = aliases.alias_commentary(
        "comm_seg1", 1,  # different chunk, same purport
        addr_label="БГ 18.66", author_name="А.Ч. Прабхупада",
        sentences=["Fourth sentence.", "Fifth."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref_a}|s=0]\n[^{ref_b}|s=0]\n")
    # Single attribution line — proves the two markers MERGED into one
    # blockquote (not two glued ones with separate attributions).
    assert out.count("— А.Ч. Прабхупада, БГ 18.66") == 1
    # Both picked sentences present and on the SAME blockquote line.
    assert "First sentence." in out
    assert "Fourth sentence." in out
    # Verify they're on the same line: find the line containing First
    # and check Fourth is on it too.
    for line in out.split("\n"):
        if "First sentence." in line:
            assert "Fourth sentence." in line
            break
    else:
        raise AssertionError("'First sentence.' line not found in output")


async def test_two_adjacent_different_source_commentary_blockquotes_separated() -> None:
    """Different authors / addr_labels → TWO distinct blockquotes with
    blank-line separation so markdown renders them as separate blocks."""
    aliases = TurnAliasMap()
    ref_a = aliases.alias_commentary(
        "ca", 0, addr_label="БГ 18.66", author_name="Author A",
        sentences=["From A."],
    )
    ref_b = aliases.alias_commentary(
        "cb", 0, addr_label="БГ 18.66", author_name="Author B",
        sentences=["From B."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref_a}|s=0]\n[^{ref_b}|s=0]\n")
    # Both attribution lines present (one per blockquote).
    assert "— Author A" in out
    assert "— Author B" in out
    # And a blank-line break separates them: `\n\n` outside any `>` line.
    # Locate the gap between the two blockquotes — must contain at least
    # two consecutive newlines for markdown to terminate the first.
    a_end = out.index("— Author A")
    b_start = out.index("> From B.")
    between = out[a_end:b_start]
    assert "\n\n" in between


async def test_commentary_followed_by_prose_then_same_source_doesnt_merge() -> None:
    """If prose has interrupted the commentary run, a follow-up marker
    with the same attribution starts a NEW blockquote — merging would
    fold prose-and-attribution back into the first quote."""
    aliases = TurnAliasMap()
    ref_a = aliases.alias_commentary(
        "ca", 0, addr_label="БГ 18.66", author_name="Author A",
        sentences=["First."],
    )
    ref_b = aliases.alias_commentary(
        "cb", 1, addr_label="БГ 18.66", author_name="Author A",
        sentences=["Second."],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref_a}|s=0]\nProse in between.\n[^{ref_b}|s=0]\n")
    # Attribution appears twice — once per blockquote.
    assert out.count("— Author A") == 2


async def test_commentary_blockquote_preserves_internal_newlines_with_gt() -> None:
    """A sentence containing internal newlines (multi-line shloka quote
    embedded in a purport) gets `>` on EVERY line, not just the first."""
    aliases = TurnAliasMap()
    sanskrit_multi = "Это подтверждает Кришна:\n*мāṁ ча йо\nбхакти-йогена севате\nкалпате*\n«Перевод».."
    ref = aliases.alias_commentary(
        "c", 0, addr_label="ЧЧ Мадхйа 25.121", author_name="Author",
        sentences=[sanskrit_multi],
    )
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[^{ref}|s=0]")
    # Each non-empty line of the sentence got its own `> ` prefix.
    assert "> *мāṁ ча йо" in out
    assert "> бхакти-йогена севате" in out
    assert "> калпате*" in out
    # No naked Sanskrit line outside a blockquote (i.e. there are no
    # lines that contain the Sanskrit text but DON'T start with `>`).
    for line in out.split("\n"):
        if "бхакти-йогена" in line:
            assert line.lstrip().startswith(">")
