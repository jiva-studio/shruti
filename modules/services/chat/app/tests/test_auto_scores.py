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
