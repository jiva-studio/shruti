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
#
# Per-kind dict so we can tune the lift independently: verses suffer most
# from short-text embeddings under-scoring against long queries, so they
# typically need a bigger nudge than lectures (which already score well).
# Keep the dict shape even when values are equal — tuning becomes a one-
# constant edit instead of a code change.
BOOST_BY_KIND: dict[str, float] = {
    "lecture":       0.30,
    "verse":         0.30,
    "commentary":    0.30,
    "prose_chapter": 0.30,
    "letter":        0.30,
}

# ---- Stage timeouts (asyncio.wait_for) -------------------------------------

# Bumped from initial dev-machine values after a prod smoke run hit
# fanout_round_0 timeout at 4.0s: 5 queries × {lecture, verse, commentary,
# prose} fanout = 20 parallel pgvector queries plus a batched OpenRouter
# embedding call. Localhost finishes in ~1s, AWS RDS + OpenRouter takes
# 6-10s on a cold pgvector cache. Give it room.
TIMEOUT_PLAN_S = 8.0
TIMEOUT_QUESTION_LOOKUP_S = 6.0
TIMEOUT_TOPIC_EXTRACT_S = 8.0
TIMEOUT_TOPIC_LOOKUP_S = 6.0
TIMEOUT_FANOUT_S = 30.0
TIMEOUT_REGENERATE_S = 8.0
TIMEOUT_FETCH_REFS_S = 5.0
TIMEOUT_COMMENTARY_EXPAND_S = 5.0

# ---- Verse → commentary expansion -----------------------------------------

# Per verse hit, this is the upper bound on how many commentary chunks
# get attached. Authors-first selection means up to N distinct purports
# appear before any second segment from one author.
MAX_COMMENTARIES_PER_VERSE = 12


# ---- Stage 2: per-thesis thin-support augmentation ------------------------

# After Stage 1 rerank, a thesis is considered "thin" if its top
# supporting_note has cosine < THIN_THESIS_MIN_SCORE or fewer than
# THIN_THESIS_MIN_STRONG_NOTES notes clear the threshold. Thin theses
# trigger a fresh thesis-targeted ANN search (Stage 2 augment).
THIN_THESIS_MIN_SCORE = 0.55
THIN_THESIS_MIN_STRONG_NOTES = 2

# How many fresh chunks Stage 2 pulls per thin thesis (split across
# lecture + library kinds inside _augment_one). Kept small — augment
# only fires when initial pool was already insufficient; flooding with
# 30 more chunks would just shift the noise problem one level down.
AUGMENT_FRESH_TOP_K = 10

# Stage 2 ANN total budget. Used by `_safe` to avoid runaway on a thin
# thesis if pgvector hangs.
TIMEOUT_AUGMENT_S = 6.0
