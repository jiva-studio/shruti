"""Sufficiency gate — decides, BEFORE the wide corpus fanout, whether curated
authoritative evidence already answers the turn.

A pinned question-attribution match → SHORT (lean, authoritative-first);
otherwise LONG (full corpus sweep, 100-200 sources, ~20s). A curated MEMORY
match whose hand-picked shlokas already answer the turn also takes the lean
path. The decision is a CRAG-style bucket assessment computed from signals
already in hand (attribution matches + their resolved refs) — NO extra LLM
call.

The gate emits CORRECT / INCORRECT only; `AMBIGUOUS` is defined but no path
produces it.

A LOOSE memory match (above the inject threshold but below the short-circuit
bar) is deliberately NOT enough to skip the sweep: its note still rides as
ambient background, but a weak signal must not change the retrieval path. See
``MEMORY_CORRECT_SCORE_*``.
"""

from __future__ import annotations

from shruti_chat.research.constants import (
    LEAN_POLICY,
    MEMORY_CORRECT_SCORE_CROSS,
    MEMORY_CORRECT_SCORE_NATIVE,
    MEMORY_SUFFICIENT_REFS,
    WIDE_POLICY,
    RetrievalPolicy,
)
from shruti_chat.research.models import AttributionMatch, MemoryResolution

# Buckets (CRAG-style). Kept as plain strings so they cross the log/eval
# boundary without an enum import.
CORRECT = "correct"
AMBIGUOUS = "ambiguous"
INCORRECT = "incorrect"


def memory_is_sufficient(memory: MemoryResolution) -> bool:
    """A memory short-circuits the corpus sweep iff it BOTH resolved enough
    citable refs AND matched strongly enough to drive the path.

    Counting RESOLVED envelopes (not claimed refs) covers the case where a
    memory points at a verse missing from the chunk repo — it must not
    short-circuit on evidence that never reaches the synthesizer. The score bar
    is stage-aware: a cross-lingual match carries the ~10-15pt embedder penalty,
    so it clears a lower bar than a native-language one."""
    if not memory.matched:
        return False
    if len(memory.envelopes) < MEMORY_SUFFICIENT_REFS:
        return False
    bar = (
        MEMORY_CORRECT_SCORE_CROSS
        if memory.stage == "cross"
        else MEMORY_CORRECT_SCORE_NATIVE
    )
    return memory.score >= bar


def assess_sufficiency(
    question_matches: list[AttributionMatch],
    memory: MemoryResolution,
) -> str:
    """Bucket the turn from curated authoritative evidence alone.

    - A pinned question-attribution → CORRECT (the lean path).
    - A memory match that is `memory_is_sufficient` (enough resolved refs
      AND a strong-enough score) is also CORRECT — the curator picked exactly
      these shlokas for this note, stronger ground truth than any fanout pool,
      so the wide sweep is skipped.
    - Everything else is INCORRECT (the full LONG fanout owns it). A loose
      memory match lands here too: its note still injects, but it does not
      change the path.
    """
    if question_matches:
        return CORRECT
    if memory_is_sufficient(memory):
        return CORRECT
    return INCORRECT


def policy_for(bucket: str) -> RetrievalPolicy:
    """Map a sufficiency bucket to the retrieval preset that drives the path.

    CORRECT → LEAN (curated authoritative refs + bounded supplementary fanout);
    everything else → WIDE (full boosted fanout with coverage rounds). The
    SHORT/LONG fork is this one configurable decision."""
    return LEAN_POLICY if bucket == CORRECT else WIDE_POLICY
