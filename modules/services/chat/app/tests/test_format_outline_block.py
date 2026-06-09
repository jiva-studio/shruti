"""Tests for `_sanitize_header` and `_format_outline_block` —
the synthesizer-side rendering of an Outline into an LLM-facing
directive block. Covers the header-length defense added after live
testing showed the planner LLM occasionally emitting whole-sentence
headers despite the 3-5 word prompt rule.
"""

from __future__ import annotations

from lectorium_chat.application.synthesizer_turn import (
    _format_outline_block,
    _sanitize_header,
)
from lectorium_chat.research.models import Outline, Thesis


# ── _sanitize_header ────────────────────────────────────────────────


def test_sanitize_header_keeps_short_label() -> None:
    assert _sanitize_header("Природа кармы") == "Природа кармы"


def test_sanitize_header_strips_trailing_punctuation() -> None:
    # A header is a label, not a sentence — shouldn't end like one.
    assert _sanitize_header("Природа кармы.") == "Природа кармы"
    assert _sanitize_header("Природа кармы!") == "Природа кармы"
    assert _sanitize_header("Природа кармы…") == "Природа кармы"


def test_sanitize_header_returns_none_for_empty() -> None:
    assert _sanitize_header(None) is None
    assert _sanitize_header("") is None
    assert _sanitize_header("   ") is None


def test_sanitize_header_drops_too_long_chars() -> None:
    """Header longer than 50 chars → drop (the LLM packed the thesis
    into the header field by mistake). Synthesizer renders the paragraph
    without a misleading bold preamble."""
    too_long = "Кармическая деятельность освобождает преданного от материального рабства"
    assert _sanitize_header(too_long) is None


def test_sanitize_header_drops_too_many_words() -> None:
    """7+ words → drop, even if char count is small."""
    assert _sanitize_header("Один два три четыре пять шесть семь") is None


def test_sanitize_header_keeps_6_word_max() -> None:
    """Exactly 6 words is the cap; 7 starts dropping."""
    assert _sanitize_header("Один два три четыре пять шесть") == "Один два три четыре пять шесть"


# ── _format_outline_block ───────────────────────────────────────────


def _outline(*theses: Thesis, intro: str | None = None, conclusion: str | None = None) -> Outline:
    return Outline(intro=intro, theses=list(theses), conclusion=conclusion)


def test_format_outline_block_with_short_header_renders_header_line() -> None:
    block = _format_outline_block(_outline(
        Thesis(thesis="Long thesis claim.", header="Природа кармы",
               supporting_notes=[1]),
    ))
    assert 'header="Природа кармы"' in block


def test_format_outline_block_drops_too_long_header_silently() -> None:
    """A whole-sentence header gets stripped server-side before reaching
    the synthesizer LLM — so the synthesizer won't render a misleading
    bold preamble even if the planner misbehaved."""
    block = _format_outline_block(_outline(
        Thesis(
            thesis="Real thesis claim.",
            header="Кармическая деятельность освобождает преданного от материального рабства",
            supporting_notes=[1],
        ),
    ))
    assert "header=" not in block
    # Thesis text still present so the synthesizer can render the paragraph.
    assert "Real thesis claim." in block


def test_format_outline_block_none_returns_empty_string() -> None:
    assert _format_outline_block(None) == ""


def test_format_outline_block_empty_theses_triggers_refusal_directive() -> None:
    block = _format_outline_block(_outline())
    assert "refusal" in block.lower()


def test_format_outline_block_includes_intro_directive() -> None:
    block = _format_outline_block(_outline(
        Thesis(thesis="t.", supporting_notes=[1]),
        intro="Tying intro sentence.",
    ))
    assert "INTRO" in block
    assert "Tying intro sentence." in block


def test_format_outline_block_includes_conclusion_directive() -> None:
    block = _format_outline_block(_outline(
        Thesis(thesis="t.", supporting_notes=[1]),
        conclusion="Closing thought.",
    ))
    assert "CONCLUSION" in block
    assert "Closing thought." in block


def test_format_outline_block_no_intro_no_conclusion_no_directives() -> None:
    block = _format_outline_block(_outline(
        Thesis(thesis="t.", supporting_notes=[1]),
    ))
    assert "INTRO" not in block
    assert "CONCLUSION" not in block


# ── _compact_for_outline ────────────────────────────────────────────


def test_compact_trims_pool_to_cited_notes_and_remaps_indices() -> None:
    """Task B: the synthesizer should only see the notes the outline cites,
    with supporting_notes renumbered into the compacted position space so
    `[^N]` stays aligned with _format_tool_results / the alias remap."""
    from lectorium_chat.application.synthesizer_turn import _compact_for_outline

    tool_results = [
        {"type": "lecture", "ref": 1, "text": "note 1"},
        {"type": "verse", "ref": 2, "text": "note 2"},
        {"type": "lecture", "ref": 3, "text": "note 3"},
        {"type": "commentary", "ref": 4, "text": "note 4"},
        {"type": "lecture", "ref": 5, "text": "note 5"},
    ]
    # Theses cite original positions 2 and 4 only.
    outline = Outline(theses=[
        Thesis(thesis="a", supporting_notes=[2]),
        Thesis(thesis="b", supporting_notes=[4]),
    ])

    compacted, new_outline = _compact_for_outline(tool_results, outline)

    assert [n["text"] for n in compacted] == ["note 2", "note 4"]
    # 2 → 1, 4 → 2 in the compacted space.
    assert new_outline.theses[0].supporting_notes == [1]
    assert new_outline.theses[1].supporting_notes == [2]


def test_compact_keeps_action_and_error_notes() -> None:
    from lectorium_chat.application.synthesizer_turn import _compact_for_outline

    tool_results = [
        {"type": "lecture", "ref": 1, "text": "cited"},
        {"type": "lecture", "ref": 2, "text": "uncited"},
        {"ok": True, "kind": "share_pdf", "action_id": "ab12"},
        {"error": "boom"},
    ]
    outline = Outline(theses=[Thesis(thesis="a", supporting_notes=[1])])

    compacted, new_outline = _compact_for_outline(tool_results, outline)

    kinds = [n.get("type") or n.get("kind") or ("error" if "error" in n else "?") for n in compacted]
    # cited note 1 + the action card + the error note survive; uncited dropped.
    assert "share_pdf" in kinds
    assert "error" in kinds
    assert "uncited" not in [n.get("text") for n in compacted]
    assert new_outline.theses[0].supporting_notes == [1]


def test_compact_noop_without_outline() -> None:
    from lectorium_chat.application.synthesizer_turn import _compact_for_outline

    tool_results = [{"type": "lecture", "ref": 1, "text": "x"}]
    out_results, out_outline = _compact_for_outline(tool_results, None)
    assert out_results is tool_results  # free-form path untouched
    assert out_outline is None
