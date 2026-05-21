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
