"""Thresholds and timeouts for the research pipeline.

Asymmetric thresholds by attribution kind and lookup stage (the kinds are
named after the search-industry pin/boost distinction):
  - pinned (becomes authoritative, cited literally) → high bar
  - boost (just boosts score, error = missing boost) → lower bar
  - cross-lingual fallback gets a small concession for the ~10-15pt MIRACL
    penalty inherent to text-embedding-3-small on non-English queries
"""

from __future__ import annotations

# ---- Attribution lookup ----------------------------------------------------

# pinned-attribution (authoritative; SHORT path)
PINNED_ACCEPT_SCORE_NATIVE = 0.85
PINNED_ACCEPT_SCORE_CROSS = 0.80
PINNED_BORDER_SCORE = 0.70             # 0.70..accept → cross-encoder gate for top1
PINNED_MAX_MATCHES = 3                 # multi-match cap
# Border-zone gate: a bi-encoder cosine of 0.70–0.85 is "maybe" — it never read
# the two texts together. So we re-judge the top candidate with the SAME Voyage
# cross-encoder the fanout uses, scoring (user query × the curated phrasing) as a
# pair. Accept iff that relevance ≥ PINNED_RERANK_ACCEPT. This replaces the old
# LLM-confirm, which was fed neither the query nor the canonical text and so
# coin-flipped. Voyage relevance is uncalibrated; 0.50 is a deliberate midpoint —
# tune from the `attribution_rerank` log line on real border traces.
PINNED_RERANK_ACCEPT = 0.50
PINNED_RERANK_CANDIDATE_POOL = 5       # rerank curated phrasings from the top-N
                                       # border candidates (guarantees ≥2 docs;
                                       # Voyage no-ops on a single document)

# boost-attribution (ranking signal; LONG path)
BOOST_ACCEPT_SCORE_NATIVE = 0.70
BOOST_ACCEPT_SCORE_CROSS = 0.65
BOOST_MAX_MATCHES_PER_TOPIC = 3
TOPIC_MAX_TOPICS_EXTRACTED = 5         # cap on LLM output (query topic extraction)

# ---- Fanout / coverage -----------------------------------------------------

COVERAGE_MIN_MAX_SCORE = 0.55
COVERAGE_MIN_LECTURES = 2
MAX_FANOUT_ROUNDS = 2
TOPK_PER_QUERY = 8

# ---- Cross-encoder rerank (Stage A) ----------------------------------------
# Primary cutoff is TOP-K everywhere. Cross-encoder scores are NOT calibrated
# across queries (Voyage/Cohere: relative-rank-within-a-query only), so an
# absolute rerank floor is NEVER the primary selector.
RERANK_POOL_CAP = 60      # rerank input: top-N by cosine. Chat sweet spot is
                          # 20–50; 60 leaves headroom while bounding the call.
RERANK_FETCH_TOP_K = 24   # per-sub-query ANN fetch used to build that pool
RERANK_TOP_K = 16         # keep top-N by rerank_score; feeds the outline.
                          # Stage B narrows per-thesis.
RERANK_MIN_LECTURES = 2   # reserve ≥N lecture slots in the cut (= COVERAGE_MIN_LECTURES)
                          # so lecture starvation can't trip a spurious coverage round.
RERANK_NOISE_PREFLOOR = 0.18  # permissive COSINE pre-floor — drops pure garbage only,
                              # well below the ~0.30 verses the old 0.45 floor killed.

# Per-family reserve in the rerank cut. The Voyage cross-encoder favours
# conversational lecture/prose text and its scores are within-query-relative
# (not comparable across kinds), so terse verse chunks get 0 of the top-K even
# when topically dead-on. Mirror RERANK_MIN_LECTURES for verses and the rest of
# the library so shlokas + commentary survive the cut. Gated by a cosine floor
# so we never force low-relevance junk (honours the empty-result discipline).
RERANK_MIN_VERSES = 2       # reserve ≥N verse slots past the top-K cut
RERANK_MIN_LIBRARY = 2      # reserve ≥N commentary/prose_chapter/letter slots
RERANK_RESERVE_FLOOR = 0.40  # cosine floor for reserve eligibility — above
                             # NOISE_PREFLOOR (0.18), below RELEVANCE_FLOOR (0.45).
                             # The one value to calibrate from prod verse cosines.

# Final-cut membership guarantee for the LONG-path top_chunks[:20] and SHORT-path
# supplementary[:8] slices: even when the rerank reserve seats verses into a round,
# the cross-round merge + final cap can drop them again. Back-fill this many from
# the tail (same RERANK_RESERVE_FLOOR gate) so the planner actually sees them.
FINAL_CUT_MIN_VERSES = 1
FINAL_CUT_MIN_LIBRARY = 1

# ---- Hybrid lexical retrieval (P2) -----------------------------------------
# A non-cosine recall lane (full-text + pg_trgm address) fused with dense ANN
# via Reciprocal Rank Fusion. Catches what the English-centric embedder misses:
# canonical addresses ("БГ 2.13"), Sanskrit transliteration, and short verses.
# Membership only — the cross-encoder still orders. Active only on the rerank
# path (the lexical hit needs the reranker to re-score it on its text).
RRF_K = 60                  # standard RRF constant: score = Σ 1/(RRF_K + rank)
LEXICAL_FETCH_TOP_K = 24    # per-sub-query lexical fetch (mirror RERANK_FETCH_TOP_K);
                            # caps the lexical arm so it can't crowd the rerank pool.
LEXICAL_TRGM_MIN_SIM = 0.3  # pg_trgm similarity threshold for the address `%` match.
# Authoritative score for an EXACT address the user named in the query
# ("БГ 2.13"), fetched deterministically. Mirrors the SHORT-path question-ref
# convention (`canonical_score=0.85`) — an explicitly-named, existing verse is
# as authoritative as a curator question-attribution.
ADDRESS_HIT_SCORE = 0.85

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
