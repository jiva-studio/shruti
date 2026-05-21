"""Unit tests for research.coverage_gate."""

from __future__ import annotations

from shruti_chat.research.coverage_gate import is_coverage_sufficient
from shruti_chat.research.models import FanoutResult


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
