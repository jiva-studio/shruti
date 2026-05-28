"""Tests for `_render_one_note` — LLM-facing note formatting.

Focus on the commentary-header leakage fix: prior shape `[^N] БГ 2.13 —
комментарий, Прабхупада\\n[s=0] …` made weaker models copy the prosy
header text into their answers' trailing lines. Switched to bare
`[^N]\\n[s=0] …`, symmetric with the verse case — server-side marker
expander still renders the full attribution from alias storage.
"""

from __future__ import annotations

from shruti_chat.application.synthesizer_turn import _render_one_note


def _commentary_note(*, ref=7, addr_label="БГ 2.13",
                     author="А.Ч. Прабхупада",
                     sentences=None, text="full commentary body") -> dict:
    return {
        "type": "commentary",
        "ref": ref,
        "label": addr_label,
        "text": text,
        "score": 0.7,
        "meta": {
            "source_id": "src_BG",
            "tokens": "2.13",
            "author_id": "prabhupada",
            "author_name": author,
            "sentences": sentences or ["Sentence A.", "Sentence B."],
        },
    }


def test_commentary_header_is_bare_ref_only() -> None:
    """The commentary header must be `[^7]` alone — no addr_label,
    no author, no Russian word `комментарий`. Anything else primes
    weaker synthesizer models to leak it as plain text."""
    note = _commentary_note()
    out = _render_one_note(1, note)
    first_line = out.split("\n", 1)[0]
    assert first_line == "[^7]"
    # Defensive — ensure none of the prosy bits sneak into the body
    # header line (the actual sentence body comes BELOW, prefixed `[s=N]`).
    assert "БГ 2.13" not in first_line
    assert "комментарий" not in first_line
    assert "Прабхупада" not in first_line


def test_commentary_sentences_still_indexed_below_header() -> None:
    """The sentence-pick mechanic (`[^N|s=0,2]`) requires `[s=N]`
    prefixes on each sentence — verify they're still there even after
    the header trim."""
    note = _commentary_note(sentences=["First.", "Second.", "Third."])
    out = _render_one_note(1, note)
    assert "[s=0] First." in out
    assert "[s=1] Second." in out
    assert "[s=2] Third." in out


def test_commentary_with_missing_author_still_bare() -> None:
    """Author absent (no catalog hit) — header still `[^N]`, no
    leakage of `комментарий` word or addr_label."""
    note = _commentary_note(author=None)
    out = _render_one_note(1, note)
    first_line = out.split("\n", 1)[0]
    assert first_line == "[^7]"
    assert "комментарий" not in first_line


def test_commentary_with_no_sentences_still_renders_bare_header() -> None:
    """Defensive: commentary with empty sentences list shouldn't crash
    or fall through to a different rendering path that re-introduces
    the addr_label."""
    note = _commentary_note(sentences=[])
    out = _render_one_note(1, note)
    # Falls through past the sentence-indexed branch; verifies the bare
    # header itself wasn't built with addr_label.
    assert "[^7]" in out
    assert "БГ 2.13" not in out.split("\n", 1)[0]


def test_verse_header_remains_bare() -> None:
    """Regression: the verse-header fix predates this PR. Make sure
    we didn't accidentally re-introduce the addr_label."""
    note = {
        "type": "verse",
        "ref": 3,
        "label": "БГ 9.22",
        "text": "ananyāś cintayanto māṁ…",
        "score": 0.78,
        "meta": {"source_id": "src_BG", "tokens": "9.22"},
    }
    out = _render_one_note(1, note)
    first_line = out.split("\n", 1)[0]
    assert first_line == "[^3]"
    assert "БГ 9.22" not in first_line


def test_lecture_header_keeps_natural_language_title() -> None:
    """Lectures intentionally keep their title in the header — a title
    like 'Утренняя прогулка, 1976-04-03, Бомбей' doesn't look like a
    shloka address and doesn't cause leakage. Make sure this fix
    didn't accidentally bleed into the lecture case."""
    note = {
        "type": "lecture",
        "ref": 5,
        "label": "Утренняя прогулка, 1976-04-03",
        "text": "…discussion text…",
        "score": 0.65,
        "meta": {"start_ms": 0, "end_ms": 1000},
    }
    out = _render_one_note(1, note)
    first_line = out.split("\n", 1)[0]
    assert first_line == "[^5] Утренняя прогулка, 1976-04-03"
