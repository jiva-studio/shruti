"""coverage_gate — decide whether the fanout result is good enough to stop.

Tracks two thresholds:
  - `max_score`: at least one chunk must be sufficiently relevant
  - `min_lectures`: at least N lecture chunks (lectures are the headline
    content; a research turn that returns only verses/commentaries with no
    lecture support is usually thin)
"""

from __future__ import annotations

from lectorium_chat.research.constants import (
    COVERAGE_MIN_LECTURES,
    COVERAGE_MIN_MAX_SCORE,
)
from lectorium_chat.research.models import FanoutResult


def is_coverage_sufficient(
    result: FanoutResult,
    *,
    min_max_score: float = COVERAGE_MIN_MAX_SCORE,
    min_lectures: int = COVERAGE_MIN_LECTURES,
) -> bool:
    """Return True when the fanout result is dense enough to stop iterating.

    Both conditions must hold:
      - `result.max_score >= min_max_score`
      - At least `min_lectures` chunks of `kind='lecture'` (the synthesizer
        needs lecture context to compose paragraphs; verses alone leave it
        nothing to ground prose in).
    """
    if result.max_score < min_max_score:
        return False
    lecture_count = len(result.by_kind.get("lecture", []))
    return lecture_count >= min_lectures


# Stage 2.8.c — round-aware gate. The strict gate above requires BOTH a
# score floor AND `min_lectures` lectures, which forces a second fanout
# round on thin-corpus topics that already have a strong single hit.
# We accept a confident high-score hit (>= 0.65) even with sparse lectures
# from round 0 onward: prod traces show the second round costs
# regenerate_queries (~7s) + another fanout (~2s) ≈ +9s wall-clock and
# rarely improves an answer that already has a confident hit. We still bail
# early when round 0 returned nothing usable — regenerate_queries rarely
# recovers from `max_score < 0.40`.

_EARLY_EXIT_MAX_SCORE = 0.65
_BAILOUT_MAX_SCORE = 0.40


def is_coverage_good_enough(
    result: FanoutResult,
    round_idx: int,
    *,
    min_max_score: float = COVERAGE_MIN_MAX_SCORE,
    min_lectures: int = COVERAGE_MIN_LECTURES,
) -> bool:
    """Round-aware variant of `is_coverage_sufficient`.

    Stops iterating when EITHER:
      - the strict gate holds (`max_score >= min_max_score` AND at least
        `min_lectures` lectures), OR
      - we already have a confident hit (`max_score >= 0.65`) — a single
        strong result beats a lecture-quantity bar, and chasing the bar
        with a second fanout round is rarely worth its ~9s cost.

    `round_idx` is retained for callsite symmetry and future round-specific
    tuning; the confident-hit shortcut now applies from round 0.
    """
    if is_coverage_sufficient(
        result, min_max_score=min_max_score, min_lectures=min_lectures
    ):
        return True
    if result.max_score >= _EARLY_EXIT_MAX_SCORE:
        return True
    return False


def should_bail_out(result: FanoutResult) -> bool:
    """Whether to stop iterating without more rounds.

    Returns True when round 0 came back with nothing remotely relevant
    (`max_score < 0.40`); rolling the dice on a second fanout round in
    that state burns a regenerate_queries LLM call for ~no improvement.
    The synthesizer's refusal-discipline (`synthesizer_turn.py:250-277`)
    handles the empty-grounding case cleanly.
    """
    return result.max_score < _BAILOUT_MAX_SCORE
