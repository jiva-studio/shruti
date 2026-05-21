"""Thresholds and timeouts for the research pipeline.

Asymmetric thresholds by attribution kind and lookup stage:
  - question (becomes authoritative, cited literally) → high bar
  - topic (just boosts score, error = missing boost) → lower bar
  - cross-lingual fallback gets a small concession for the ~10-15pt MIRACL
    penalty inherent to text-embedding-3-small on non-English queries
"""

from __future__ import annotations

# ---- Attribution lookup ----------------------------------------------------

# question-attribution
QUESTION_ACCEPT_SCORE_NATIVE = 0.85
QUESTION_ACCEPT_SCORE_CROSS = 0.80
QUESTION_BORDER_SCORE = 0.70           # 0.70..accept → LLM-confirm for top1
QUESTION_MAX_MATCHES = 3               # multi-match cap

# topic-attribution
TOPIC_ACCEPT_SCORE_NATIVE = 0.70
TOPIC_ACCEPT_SCORE_CROSS = 0.65
TOPIC_MAX_MATCHES_PER_TOPIC = 3
TOPIC_MAX_TOPICS_EXTRACTED = 5         # cap on LLM output

# ---- Fanout / coverage -----------------------------------------------------

COVERAGE_MIN_MAX_SCORE = 0.55
COVERAGE_MIN_LECTURES = 2
MAX_FANOUT_ROUNDS = 2
TOPK_PER_QUERY = 8

# Topic-boost: added to chunk.score when item_id is referenced by a matched
# topic-attribution. Capped at 1.0 downstream to avoid breaking score-based
# refusal checks in the synthesizer (which expects [0, 1]).
DEFAULT_TOPIC_BOOST = 0.15

# ---- Stage timeouts (asyncio.wait_for) -------------------------------------

TIMEOUT_EXPAND_S = 5.0
TIMEOUT_QUESTION_LOOKUP_S = 3.0
TIMEOUT_TOPIC_EXTRACT_S = 5.0
TIMEOUT_TOPIC_LOOKUP_S = 3.0
TIMEOUT_FANOUT_S = 4.0
TIMEOUT_REGENERATE_S = 5.0
TIMEOUT_FETCH_REFS_S = 2.0
