"""Unit tests for `audit_post_expansion_text` — the post-stream metric
sweep used by `emit_turn_scores`.

Currently focused on the sentence-marker leak metric added for issue
#659: when the LLM emits a bare `[s=0,1]` token (the `|s=…` payload
escaped from its `[^N|s=…]` footnote wrapper) the MarkerExpander has
no rule to strip it, so it leaks to the client. We measure the leak
on `final_text` so the producer regression shows up on every turn
without waiting for user feedback.
"""

from __future__ import annotations

import pytest

from lectorium_chat.observability.auto_scores import (
    audit_post_expansion_text,
    emit_turn_scores,
    MarkerAudit,
    TurnSummary,
)


# ── sentence_marker_leak ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sentence_marker_leak_counts_bare_s_tokens() -> None:
    """`[s=0,1]` in the final text — bare, no `^N` wrapper — is the
    leak shape from issue #659. We count each occurrence."""
    text = "Прабхупада пишет [s=0,1] и продолжает [s=2]."
    audit = await audit_post_expansion_text(
        text,
        llm_raw_prose=text,
        malformed_dropped_count=0,
        catalog_repo=None,
        library_db_path=None,
    )
    assert audit.sentence_marker_leak == 2


@pytest.mark.asyncio
async def test_sentence_marker_leak_zero_on_clean_text() -> None:
    """Clean prose with no sentence-suffix tokens → zero leak."""
    text = "Душа вечна и неуничтожима. [cite:track_X@0-1000]"
    audit = await audit_post_expansion_text(
        text,
        llm_raw_prose=text,
        malformed_dropped_count=0,
        catalog_repo=None,
        library_db_path=None,
    )
    assert audit.sentence_marker_leak == 0


@pytest.mark.asyncio
async def test_sentence_marker_leak_ignores_well_formed_footnotes() -> None:
    """`[^7|s=0,2]` is the LEGAL form — the `s=` lives INSIDE the
    `[^N|…]` wrapper. The leak regex looks for `[s=…]` with `[` then
    `s` directly, which the wrapper form doesn't match (it has `^7|`
    in between). MarkerExpander normally expands `[^N|s=…]` server-
    side anyway; this test guards the regex shape directly so a future
    refactor doesn't accidentally start double-counting."""
    text = "see [^7|s=0,2] and [^3|s=1] in the chunk"
    audit = await audit_post_expansion_text(
        text,
        llm_raw_prose=text,
        malformed_dropped_count=0,
        catalog_repo=None,
        library_db_path=None,
    )
    assert audit.sentence_marker_leak == 0


@pytest.mark.asyncio
async def test_sentence_marker_leak_counts_single_index() -> None:
    """`[s=0]` (one sentence index, no comma) is still a leak."""
    text = "tail [s=0] tail"
    audit = await audit_post_expansion_text(
        text,
        llm_raw_prose=text,
        malformed_dropped_count=0,
        catalog_repo=None,
        library_db_path=None,
    )
    assert audit.sentence_marker_leak == 1


# ── marker_validity gating ───────────────────────────────────────────


def test_marker_validity_false_when_only_sentence_leak(monkeypatch) -> None:
    """A turn with malformed=0, broken=0 but a bare `[s=…]` leak
    should still trip `marker_validity` to false — the leak is visible
    garbage in the client bubble even when the strict-grammar scans
    come back clean."""
    captured: dict[str, object] = {}

    class _StubLangfuse:
        def create_score(self, *, name, value, data_type, trace_id, score_id):
            captured[name] = value

    audit = MarkerAudit(
        malformed=0,
        broken=0,
        bypass=0,
        cite_count=0,
        sentence_marker_leak=1,
    )
    summary = TurnSummary(
        request_lang="ru",
        latency_total_ms=100,
        first_token_ms=10,
        tool_calls_count=0,
        response_length_chars=20,
        had_error=False,
        intent=None,
        final_text="...",
    )
    emit_turn_scores(_StubLangfuse(), "trace_xyz", summary, audit)

    assert captured["marker_validity"] == 0
    assert captured["sentence_marker_leak_count"] == 1


def test_marker_validity_true_when_all_clean() -> None:
    captured: dict[str, object] = {}

    class _StubLangfuse:
        def create_score(self, *, name, value, data_type, trace_id, score_id):
            captured[name] = value

    audit = MarkerAudit(
        malformed=0,
        broken=0,
        bypass=0,
        cite_count=3,
        sentence_marker_leak=0,
    )
    summary = TurnSummary(
        request_lang="ru",
        latency_total_ms=100,
        first_token_ms=10,
        tool_calls_count=0,
        response_length_chars=20,
        had_error=False,
        intent=None,
        final_text="clean",
    )
    emit_turn_scores(_StubLangfuse(), "trace_xyz", summary, audit)

    assert captured["marker_validity"] == 1
    assert captured["sentence_marker_leak_count"] == 0


# ── language_match ───────────────────────────────────────────────────


def _run_scores(*, request_lang: str, final_text: str) -> dict[str, object]:
    """Drive `emit_turn_scores` once and return the captured score map."""
    captured: dict[str, object] = {}

    class _StubLangfuse:
        def create_score(self, *, name, value, data_type, trace_id, score_id):
            captured[name] = value

    audit = MarkerAudit(malformed=0, broken=0, bypass=0, cite_count=0, sentence_marker_leak=0)
    summary = TurnSummary(
        request_lang=request_lang,
        latency_total_ms=100,
        first_token_ms=10,
        tool_calls_count=0,
        response_length_chars=len(final_text),
        had_error=False,
        intent=None,
        final_text=final_text,
    )
    emit_turn_scores(_StubLangfuse(), "trace_xyz", summary, audit)
    return captured


# A correct Serbian (Latin-script) answer for a `sr-Latn` user. The old
# Cyrillic-vs-Latin detector saw Latin → "en" → mismatch, so this case
# (the whole point of the fix) used to score 0.
def test_language_match_serbian_latin_answer_matches_sr_locale() -> None:
    text = "Danas ćemo razgovarati o tome kako su učenici u Londonu predano širili duhovno znanje."
    captured = _run_scores(request_lang="sr-Latn", final_text=text)
    assert captured["language_match"] == 1


# The actual production bug: the `find_track` path answered a Serbian
# user in English. That genuinely IS a mismatch and must score 0.
def test_language_match_english_answer_to_serbian_user_is_mismatch() -> None:
    text = "I didn't find any lectures or transcripts on this topic in the current research results."
    captured = _run_scores(request_lang="sr-Latn", final_text=text)
    assert captured["language_match"] == 0


def test_language_match_spanish_answer_matches_es_locale() -> None:
    text = "Hoy hablaremos de cómo los discípulos en Londres difundieron el conocimiento espiritual."
    captured = _run_scores(request_lang="es", final_text=text)
    assert captured["language_match"] == 1


# Non-Latin script still works (the old heuristic returned "ru" for any
# Cyrillic and None/garbage for Devanagari).
def test_language_match_hindi_answer_matches_hi_locale() -> None:
    text = "आज हम चर्चा करेंगे कि लंदन में शिष्यों ने किस प्रकार आध्यात्मिक ज्ञान का प्रचार किया।"
    captured = _run_scores(request_lang="hi", final_text=text)
    assert captured["language_match"] == 1


def test_language_match_russian_answer_matches_ru_locale() -> None:
    text = "Сегодня мы поговорим о том, как ученики в Лондоне преданно распространяли духовное знание."
    captured = _run_scores(request_lang="ru", final_text=text)
    assert captured["language_match"] == 1


# Too short to identify reliably → abstain, don't emit a noisy score.
def test_language_match_not_emitted_for_short_text() -> None:
    captured = _run_scores(request_lang="sr-Latn", final_text="Hvala!")
    assert "language_match" not in captured
