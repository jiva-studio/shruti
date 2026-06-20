"""Unit tests for the sufficiency gate (issue #1068, Phase 1)."""

from __future__ import annotations

from lectorium_chat.research.constants import LEAN_POLICY, WIDE_POLICY
from lectorium_chat.research.models import AttributionMatch, MemoryResolution
from lectorium_chat.research.sufficiency import (
    CORRECT,
    INCORRECT,
    assess_sufficiency,
    memory_is_sufficient,
    policy_for,
)


def _pinned(score: float = 0.9) -> AttributionMatch:
    return AttributionMatch(
        attribution_id="attribution_q", kind="pinned", refs=[],
        score=score, stage="native",
    )


def _mem(n_refs: int, score: float, stage: str = "native") -> MemoryResolution:
    envs = [{"_dedup_key": ("verse", f"v{i}", 0)} for i in range(n_refs)]
    return MemoryResolution(
        note="note", attribution_id="attribution_m" if n_refs or score else None,
        envelopes=envs, score=score, stage=stage,
    )


def test_pinned_match_is_correct() -> None:
    assert assess_sufficiency([_pinned()], MemoryResolution()) == CORRECT


def test_pinned_wins_over_absent_memory() -> None:
    assert assess_sufficiency([_pinned()], _mem(0, 0.0)) == CORRECT


def test_strong_memory_with_enough_refs_is_correct() -> None:
    # 3 resolved refs >= MEMORY_SUFFICIENT_REFS (3) AND score >= 0.70 native.
    assert assess_sufficiency([], _mem(3, 0.72)) == CORRECT
    assert assess_sufficiency([], _mem(8, 0.88)) == CORRECT


def test_loose_memory_match_does_not_short_circuit() -> None:
    # Above the inject threshold (0.60) but below the short-circuit bar (0.70):
    # the false "что такое душа" case. Note still injects elsewhere; path stays
    # INCORRECT (full sweep).
    assert assess_sufficiency([], _mem(8, 0.571)) == INCORRECT
    assert not memory_is_sufficient(_mem(8, 0.571))


def test_memory_with_too_few_resolved_refs_is_incorrect() -> None:
    assert assess_sufficiency([], _mem(2, 0.90)) == INCORRECT


def test_matched_memory_with_no_resolved_refs_is_incorrect() -> None:
    # Edge case 1: matched strongly but refs didn't resolve to citable
    # envelopes → must NOT short-circuit on evidence that never reaches the
    # synthesizer.
    assert assess_sufficiency([], _mem(0, 0.95)) == INCORRECT


def test_cross_stage_uses_lower_bar() -> None:
    # A cross-lingual match clears the lower 0.65 bar at 0.66 but a native one
    # at 0.66 does not (0.70 native bar).
    assert memory_is_sufficient(_mem(3, 0.66, stage="cross"))
    assert not memory_is_sufficient(_mem(3, 0.66, stage="native"))


def test_no_curated_evidence_is_incorrect() -> None:
    assert assess_sufficiency([], MemoryResolution()) == INCORRECT


# ---- policy presets (Phase 5) ---------------------------------------------


def test_policy_for_correct_is_lean() -> None:
    assert policy_for(CORRECT) is LEAN_POLICY
    assert not LEAN_POLICY.wide_fanout


def test_policy_for_incorrect_is_wide() -> None:
    assert policy_for(INCORRECT) is WIDE_POLICY
    assert WIDE_POLICY.wide_fanout


def test_presets_preserve_legacy_caps() -> None:
    # The collapse is behaviour-neutral: presets carry the exact prior numbers.
    assert (LEAN_POLICY.slate_size, LEAN_POLICY.supplementary_subqueries,
            LEAN_POLICY.max_fanout_rounds) == (8, 3, 0)
    assert WIDE_POLICY.slate_size == 20
    assert WIDE_POLICY.max_fanout_rounds == 2
