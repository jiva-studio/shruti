"""Unit tests for MarkerExpander — unified `[ref:N]` protocol.

History note: pre-2026-05-21 the LLM emitted 4 marker types
(`[cite:N]`, `[verse:N]`, `[card:N]`, `[outline:N]`) and had to pick
the right one from `kind=` in the note header. Flash-lite confused
them constantly. The new protocol gives the LLM ONE marker — `[ref:N]`
— and the server routes by alias type:

  ChunkRef + start/end → [cite:track@start-end|caption?]   audio
  ChunkRef without start/end → [card:track]                whole-track
  VerseRef                   → [verse:src/tokens|addr_label]  verse card

Caption is only honoured for audio fragments; verse/card ignore it
(verse uses the curator's `addr_label`, card has no caption form).

Legacy markers ([cite:N|...], [verse:N|...], [card:N], [outline:N])
and document-kind hallucinations ([commentary:...], [purport:...])
are dropped — see `chat_marker_legacy_or_hallucinated_dropped` log.
"""

from __future__ import annotations

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap


async def _expand(expander: MarkerExpander, text: str) -> str:
    """Feed text fully then drain the tail."""
    fed = await expander.feed(text)
    tail = await expander.flush()
    return fed + tail


# ── [ref:N] — audio fragment (ChunkRef with start/end) ───────────────


async def test_ref_to_lecture_chunk_expands_to_cite() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 12_000, 15_000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"see this [ref:{ref}|key point].")
    assert out == "see this [cite:track_X@12000-15000|key point]."


async def test_ref_to_lecture_chunk_no_caption() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[ref:{ref}]")
    assert out == "[cite:track_X@0-1000]"


# ── [ref:N] — verse (VerseRef) ────────────────────────────────────────


async def test_ref_to_verse_expands_to_verse_marker() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_NoY8sAlXF1IT", "12.5.8", addr_label="ШБ 12.5.8")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"here: [ref:{ref}]")
    assert out == "here: [verse:source_NoY8sAlXF1IT/12.5.8|ШБ 12.5.8]"


async def test_ref_to_verse_uses_addr_label_not_llm_caption() -> None:
    """Verse caption is always the curator's addr_label — LLM-supplied
    caption is ignored so we don't have to trust the model's wording."""
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("source_X", "2.13", addr_label="БГ 2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[ref:{ref}|something different]")
    assert out == "[verse:source_X/2.13|БГ 2.13]"


async def test_ref_to_verse_without_addr_label() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_verse("BG", "2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[ref:{ref}]")
    assert out == "[verse:BG/2.13]"


# ── [ref:N] — whole-track card (ChunkRef without start/end) ──────────


async def test_ref_to_track_expands_to_card() -> None:
    aliases = TurnAliasMap()
    ref = aliases.alias_track("track_card_X")
    e = MarkerExpander(aliases)
    out = await _expand(e, f"[ref:{ref}]")
    assert out == "[card:track_card_X]"


# ── unknown / malformed refs ─────────────────────────────────────────


async def test_ref_unknown_alias_is_dropped() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "ghost [ref:9999] tail")
    assert out == "ghost  tail"


async def test_ref_with_non_integer_arg_is_dropped() -> None:
    """A malformed `[ref:abc]` doesn't match the integer regex and falls
    to the pass-through branch — it stays in the output (no harm: not a
    recognized client marker, so just looks like plain text)."""
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[ref:abc]")
    assert out == "[ref:abc]"


# ── legacy / hallucinated markers ────────────────────────────────────


async def test_legacy_cite_marker_is_dropped() -> None:
    """LLM occasionally regresses to the old `[cite:N|...]` syntax —
    dropped silently so the user doesn't see raw bracket text."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_X", 0, 1000)  # mint alias 1 so [cite:1] *would* resolve
    e = MarkerExpander(aliases)
    out = await _expand(e, "before [cite:1|hi] after")
    assert out == "before  after"


async def test_legacy_verse_marker_is_dropped() -> None:
    aliases = TurnAliasMap()
    aliases.alias_verse("BG", "2.13", addr_label="БГ 2.13")
    e = MarkerExpander(aliases)
    out = await _expand(e, "before [verse:1|БГ 2.13] after")
    assert out == "before  after"


async def test_legacy_card_marker_is_dropped() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[card:1]")
    assert out == ""


async def test_legacy_outline_marker_is_dropped() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[outline:1]")
    assert out == ""


async def test_hallucinated_doc_marker_is_dropped() -> None:
    """The other regression: LLM invents `[commentary:BG 10.22]` /
    `[purport:…]` by analogy. Server drops; user sees no bracket text."""
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "before [commentary:BG 10.22] after")
    assert out == "before  after"

    e2 = MarkerExpander(TurnAliasMap())
    out2 = await _expand(e2, "[purport:SB 5.5.3]")
    assert out2 == ""


# ── pass-through behaviour ───────────────────────────────────────────


async def test_action_marker_passes_through_untouched() -> None:
    """Action markers carry server-issued action_ids; not the expander's job."""
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[action:create_playlist|id=ab12cd34]")
    assert out == "[action:create_playlist|id=ab12cd34]"


async def test_followup_marker_passes_through_untouched() -> None:
    e = MarkerExpander(TurnAliasMap())
    out = await _expand(e, "[followup:Что такое разум?]")
    assert out == "[followup:Что такое разум?]"


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


async def test_ref_marker_split_across_chunks_still_expands() -> None:
    """Real SSE deltas split markers mid-buffer. Expander must reassemble."""
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_Y", 0, 1000)
    e = MarkerExpander(aliases)
    a = await e.feed(f"text [ref:{ref}")
    b = await e.feed("|cap]")
    tail = await e.flush()
    assert a + b + tail == f"text [cite:track_Y@0-1000|cap]"
