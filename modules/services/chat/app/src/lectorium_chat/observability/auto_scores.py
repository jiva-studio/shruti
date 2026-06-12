"""Heuristic auto-scoring emitted at end-of-turn.

Every chat turn produces a handful of cheap signals we can extract
without any extra LLM calls: latencies, marker counts, language match,
broken-ref count, etc. This module turns them into Langfuse scores so
they show up on every trace alongside the eventual user feedback.

Two pieces:

- `audit_post_expansion_text` — regex sweep over the final assistant
  text (post `MarkerExpander.flush`, i.e. what the client actually
  receives) to count:
    * `malformed` — `[(cite|card|outline|verse|action|followup)…]`-ish
      brackets that don't match the strict grammar in
      `mobile/.../useMarkerParser.ts`; the client renders these as raw
      text in the bubble, visible garbage.
    * `broken` — well-formed markers whose referenced track_id /
      (source_id, tokens) doesn't actually exist in the catalog /
      library. The chip renders but the player / verse card hits a
      404.

- `emit_turn_scores` — single shot of `langfuse.score_current_trace`
  calls. Called from `chat_turn.py` inside a try/except so an outage
  here never breaks the streaming path.

Names + ranges mirror `score_configs.py`; keep that file in sync when
adding a new score.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from lectorium_chat.agent.markers import (
    CARD_RE,
    CITE_RE,
    OUTLINE_RE,
    SENTENCE_MARKER_LEAK_RE,
    VERSE_RE,
)
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


# Marker grammars live in `agent/markers.py` (single source of truth,
# mirrors the client parser). The same per-kind regex serves both the
# strict scan (track / verse ids for the broken-ref + cite_count scores)
# and the bypass count below — group(1) is the track_id in every case.


@dataclass(frozen=True)
class MarkerAudit:
    malformed: int
    broken: int
    bypass: int
    cite_count: int
    sentence_marker_leak: int


async def audit_post_expansion_text(
    final_text: str,
    *,
    llm_raw_prose: str,
    malformed_dropped_count: int,
    catalog_repo: Any,
    library_db_path: Path | None,
) -> MarkerAudit:
    """One-pass audit of the final answer + the LLM-raw prose buffer.

    `final_text` is what the SSE stream emitted to the client after
    `MarkerExpander.flush` — this is the surface we measure quality on.
    Malformed markers (LLM typos / unclosed brackets in our keyword
    family) are NOT in `final_text` — the expander drops them inline
    and reports the running count via `malformed_dropped_count`. That
    count is the authoritative score; we don't re-scan the final text
    for them.

    `llm_raw_prose` is the same buffer BEFORE expansion (the
    `full_prose` concatenation in `chat_turn.py`); it's where
    bypass-protocol markers show up. In current code both are the
    same value because expansion is in-line, but we keep the seam.
    """
    # Strict-match scan — gives us track / verse ids for the broken-ref
    # check and the `cite_count` total.
    cite_track_ids: list[str] = []
    card_track_ids: list[str] = []
    outline_track_ids: list[str] = []
    verse_refs: list[tuple[str, str]] = []

    for m in CITE_RE.finditer(final_text):
        cite_track_ids.append(m.group(1))
    for m in CARD_RE.finditer(final_text):
        card_track_ids.append(m.group(1))
    for m in OUTLINE_RE.finditer(final_text):
        outline_track_ids.append(m.group(1))
    for m in VERSE_RE.finditer(final_text):
        verse_refs.append((m.group(1), m.group(2)))

    # Broken refs: batch-check tracks via catalog_repo, verses against
    # library.db. Skipped silently if catalog_repo is None (eval path).
    all_track_ids = list({tid for tid in (*cite_track_ids, *card_track_ids, *outline_track_ids)})
    broken = 0
    if all_track_ids and catalog_repo is not None:
        try:
            existing = set(await catalog_repo.filter_existing_track_ids(all_track_ids))
        except Exception as exc:  # noqa: BLE001
            log.warning("auto_scores_catalog_check_failed", error=str(exc))
            existing = set(all_track_ids)  # don't penalise on infra fail
        # `cite_track_ids` etc. may contain duplicates — we count
        # OCCURRENCES of broken refs in the prose so a multiply-cited
        # ghost track contributes proportionally.
        for tid in (*cite_track_ids, *card_track_ids, *outline_track_ids):
            if tid not in existing:
                broken += 1

    if verse_refs and library_db_path is not None and library_db_path.exists():
        broken += _count_missing_verses(library_db_path, verse_refs)

    # Bypass markers — LLM wrote `[cite:track_X@...]` directly instead
    # of going through the numbered `[^N]` protocol. Counted on the
    # LLM-raw buffer (which IS pre-expansion); on current trunk this is
    # the same as final_text.
    bypass = (
        sum(1 for _ in CITE_RE.finditer(llm_raw_prose))
        + sum(1 for _ in CARD_RE.finditer(llm_raw_prose))
        + sum(1 for _ in OUTLINE_RE.finditer(llm_raw_prose))
    )

    cite_count = len(cite_track_ids)

    # Sentence-marker leak: bare `[s=0,1]` tokens in the finalised
    # text. The `|s=…` payload is only legal as a suffix inside
    # `[^N|s=…]` — anything standalone is producer-side garbage that
    # the expander passed through as plain-bracket prose. Count is on
    # `final_text` (post-expansion), so it ONLY counts the visible
    # leak users actually see.
    sentence_marker_leak = sum(1 for _ in SENTENCE_MARKER_LEAK_RE.finditer(final_text))

    return MarkerAudit(
        malformed=malformed_dropped_count,
        broken=broken,
        bypass=bypass,
        cite_count=cite_count,
        sentence_marker_leak=sentence_marker_leak,
    )


def _count_missing_verses(
    library_db: Path,
    refs: Iterable[tuple[str, str]],
) -> int:
    """Return how many `(source_id, tokens)` pairs are NOT in library_verses.

    One short SQLite read per turn — fine to keep sync. Pulled from a
    fresh read-only connection so we don't fight a concurrent indexer
    swap.
    """
    pairs = list(refs)
    if not pairs:
        return 0
    try:
        with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
            missing = 0
            for source_id, tokens in pairs:
                row = conn.execute(
                    "SELECT 1 FROM library_verses WHERE source_id = ? AND tokens = ? LIMIT 1",
                    (source_id, tokens),
                ).fetchone()
                if row is None:
                    missing += 1
            return missing
    except Exception as exc:  # noqa: BLE001
        log.warning("auto_scores_verse_check_failed", error=str(exc))
        return 0


# ── Language match ─────────────────────────────────────────────────────


# Deterministic language identification for the `language_match` score.
# `langdetect` covers every UI locale (ru en uk sr es pt it de fr pl hu hi bn),
# replacing the old Cyrillic-vs-Latin heuristic that could only ever return
# 'ru'/'en' — and so scored every correct non-ru/en answer (e.g. a Serbian
# reply, in Latin script) as a language MISMATCH. Guarded so a missing/broken
# import degrades the score to "not emitted" rather than breaking this module's
# import (chat_turn.py imports it on the hot path).
try:
    from langdetect import DetectorFactory, LangDetectException, detect

    DetectorFactory.seed = 0  # langdetect is randomized by default; pin for stable scores
except Exception:  # pragma: no cover - langdetect is a declared dep; guard anyway
    detect = None  # type: ignore[assignment]

    class LangDetectException(Exception):  # type: ignore[no-redef]
        pass


# langdetect routinely confuses the former Serbo-Croatian dialect continuum
# (sr/hr/bs); fold them so a correct Serbian answer tagged "hr" still matches.
_LANG_EQUIV = {"hr": "sr", "bs": "sr"}

# Below this many characters langdetect is unreliable — abstain (emit nothing)
# rather than record a noisy match/mismatch.
_LANG_MIN_CHARS = 40


def _base_lang(code: str | None) -> str | None:
    """Normalize a BCP-47 / locale tag to a bucketed ISO-639-1 base:
    'sr-Latn' → 'sr', 'en-US' → 'en', then fold the sr/hr/bs continuum."""
    if not code:
        return None
    base = code.split("-")[0].lower()
    return _LANG_EQUIV.get(base, base)


def _detect_language(text: str) -> str | None:
    """Identify the answer's language as a bucketed ISO-639-1 code, or
    None when the text is too short, detection fails, or langdetect is
    unavailable. Compared against the normalized `request_lang` to score
    `language_match`."""
    if detect is None or not text or len(text.strip()) < _LANG_MIN_CHARS:
        return None
    try:
        return _base_lang(detect(text))
    except LangDetectException:
        return None


# ── emit_turn_scores ───────────────────────────────────────────────────


@dataclass
class TurnSummary:
    request_lang: str  # the client's locale tag (e.g. "ru", "en", "sr-Latn")
    latency_total_ms: int
    first_token_ms: int | None  # None if no delta was emitted
    tool_calls_count: int
    response_length_chars: int
    had_error: bool
    intent: str | None  # router intent, may be missing on non-graph paths
    final_text: str  # post-expansion, used for language_match
    # Outline shape (None when the synthesis_planner skipped — e.g.
    # action / help / catalog flows, or research-no-notes refusal).
    # Used to emit per-trace scores that let us filter Langfuse for
    # `n_theses=3 AND has_conclusion=0` style diagnostics.
    outline_n_theses: int | None = None
    outline_has_intro: bool | None = None
    outline_has_conclusion: bool | None = None
    outline_skipped_notes_ratio: float | None = None


def emit_turn_scores(
    langfuse: Any | None,
    trace_id: str,
    summary: TurnSummary,
    audit: MarkerAudit,
) -> None:
    """Fire-and-forget scoring at the very end of a turn.

    Uses `create_score(trace_id=...)` with an explicit trace id rather
    than `score_current_trace()`, so it works after the
    `with_langfuse_trace` context has already exited — which is exactly
    when this is called (the with-block closes when the SSE stream is
    fully drained, but turn-summary metrics are only complete after
    that point). Each emit is wrapped so one bad value (e.g. a
    NUMERIC out of the config range) doesn't suppress the rest.
    """
    if langfuse is None:
        return

    def _emit(name: str, value: Any, data_type: str) -> None:
        try:
            langfuse.create_score(
                name=name,
                value=value,
                data_type=data_type,
                trace_id=trace_id,
                score_id=f"{trace_id}:{name}",
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "auto_score_emit_failed",
                name=name,
                error=str(exc),
            )

    _emit("latency_total_ms", summary.latency_total_ms, "NUMERIC")
    if summary.first_token_ms is not None:
        _emit("first_token_ms", summary.first_token_ms, "NUMERIC")
    _emit("tool_calls_count", summary.tool_calls_count, "NUMERIC")
    _emit("response_length_chars", summary.response_length_chars, "NUMERIC")
    _emit("had_error", 1 if summary.had_error else 0, "BOOLEAN")

    _emit("cite_count", audit.cite_count, "NUMERIC")
    _emit("malformed_markers_count", audit.malformed, "NUMERIC")
    _emit("broken_refs_count", audit.broken, "NUMERIC")
    _emit("bypass_markers_count", audit.bypass, "NUMERIC")
    _emit("sentence_marker_leak_count", audit.sentence_marker_leak, "NUMERIC")
    _emit(
        "marker_validity",
        1
        if (audit.malformed == 0 and audit.broken == 0 and audit.sentence_marker_leak == 0)
        else 0,
        "BOOLEAN",
    )

    detected = _detect_language(summary.final_text)
    if detected is not None:
        _emit(
            "language_match",
            1 if detected == _base_lang(summary.request_lang) else 0,
            "BOOLEAN",
        )

    if summary.intent is not None:
        _emit("router_intent", summary.intent, "CATEGORICAL")

    # Outline-shape scores. Only emitted when the synthesis planner
    # actually built an outline (skipped on direct_chat / action / help
    # turns where there's no research-side outline at all).
    if summary.outline_n_theses is not None:
        _emit("outline.n_theses", summary.outline_n_theses, "NUMERIC")
    if summary.outline_has_intro is not None:
        _emit(
            "outline.has_intro",
            1 if summary.outline_has_intro else 0,
            "BOOLEAN",
        )
    if summary.outline_has_conclusion is not None:
        _emit(
            "outline.has_conclusion",
            1 if summary.outline_has_conclusion else 0,
            "BOOLEAN",
        )
    if summary.outline_skipped_notes_ratio is not None:
        _emit(
            "outline.skipped_notes_ratio",
            summary.outline_skipped_notes_ratio,
            "NUMERIC",
        )
