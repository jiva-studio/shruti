"""Unit tests for research.coverage_gate."""

from __future__ import annotations

from lectorium_chat.research.coverage_gate import (
    is_coverage_good_enough,
    is_coverage_sufficient,
    should_bail_out,
)
from lectorium_chat.research.models import FanoutResult


def _lecture(score: float) -> dict:
    return {"type": "lecture", "score": score}


def _verse(score: float) -> dict:
    return {"type": "verse", "score": score}


def test_passes_with_sufficient_lectures_and_score():
    fr = FanoutResult(
        chunks=[_lecture(0.7), _lecture(0.65), _verse(0.6)],
        by_kind={"lecture": [_lecture(0.7), _lecture(0.65)], "verse": [_verse(0.6)]},
        max_score=0.7,
    )
    assert is_coverage_sufficient(fr) is True


def test_fails_low_max_score():
    fr = FanoutResult(
        chunks=[_lecture(0.40), _lecture(0.39)],
        by_kind={"lecture": [_lecture(0.40), _lecture(0.39)]},
        max_score=0.40,
    )
    assert is_coverage_sufficient(fr) is False


def test_fails_too_few_lectures():
    fr = FanoutResult(
        chunks=[_lecture(0.8), _verse(0.7), _verse(0.6)],
        by_kind={"lecture": [_lecture(0.8)], "verse": [_verse(0.7), _verse(0.6)]},
        max_score=0.8,
    )
    assert is_coverage_sufficient(fr) is False


def test_fails_empty_result():
    assert is_coverage_sufficient(FanoutResult()) is False


def test_custom_thresholds_honored():
    fr = FanoutResult(
        chunks=[_lecture(0.5)],
        by_kind={"lecture": [_lecture(0.5)]},
        max_score=0.5,
    )
    # Default min_max_score=0.55, min_lectures=2 → fails on both.
    # Override both to relax.
    assert is_coverage_sufficient(fr, min_max_score=0.5, min_lectures=1) is True


def test_good_enough_confident_hit_stops_at_round_0():
    # Strict gate fails (only 1 lecture), but a confident hit (>= 0.65) is
    # enough to stop at round 0 — no second fanout round. This is the
    # +9s-saving shortcut that previously only fired from round 1.
    fr = FanoutResult(
        chunks=[_lecture(0.72), _verse(0.6)],
        by_kind={"lecture": [_lecture(0.72)], "verse": [_verse(0.6)]},
        max_score=0.72,
    )
    assert is_coverage_sufficient(fr) is False  # 1 lecture < min_lectures
    assert is_coverage_good_enough(fr, round_idx=0) is True
    assert is_coverage_good_enough(fr, round_idx=1) is True


def test_good_enough_weak_hit_continues_at_round_0():
    # A mid-strength hit (0.55 <= score < 0.65) with too few lectures is NOT
    # good enough on its own — round 0 still triggers a second round (unless
    # it bails out below 0.40).
    fr = FanoutResult(
        chunks=[_lecture(0.58)],
        by_kind={"lecture": [_lecture(0.58)]},
        max_score=0.58,
    )
    assert is_coverage_good_enough(fr, round_idx=0) is False
    assert should_bail_out(fr) is False
