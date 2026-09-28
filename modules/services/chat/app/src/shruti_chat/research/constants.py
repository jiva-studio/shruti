"""Thresholds and timeouts for the research pipeline.

Asymmetric thresholds by attribution kind and lookup stage (the kinds are
named after the search-industry pin/boost distinction):
  - pinned (becomes authoritative, cited literally) → high bar
  - boost (just boosts score, error = missing boost) → lower bar
  - cross-lingual fallback gets a small concession for the ~10-15pt MIRACL
    penalty inherent to text-embedding-3-small on non-English queries
"""

from __future__ import annotations

from dataclasses import dataclass

# ---- Attribution lookup ----------------------------------------------------

# pinned-attribution (authoritative; SHORT path)
PINNED_ACCEPT_SCORE_NATIVE = 0.85
PINNED_ACCEPT_SCORE_CROSS = 0.80
PINNED_BORDER_SCORE = 0.70             # 0.70..accept → cross-encoder gate for top1
PINNED_MAX_MATCHES = 3                 # multi-match cap
# Border-zone gate: a bi-encoder cosine of 0.70–0.85 is "maybe" — it never read
# the two texts together. So we re-judge the top candidate with the SAME Voyage
# cross-encoder the fanout uses, scoring (user query × the curated phrasing) as a
# pair. Accept iff that relevance ≥ PINNED_RERANK_ACCEPT. Voyage relevance is
# uncalibrated; 0.50 is a deliberate midpoint —
# tune from the `attribution_rerank` log line on real border traces.
PINNED_RERANK_ACCEPT = 0.50
PINNED_RERANK_CANDIDATE_POOL = 5       # rerank curated phrasings from the top-N
                                       # border candidates (guarantees ≥2 docs;
                                       # Voyage no-ops on a single document)

# boost-attribution (ranking signal; LONG path)
BOOST_ACCEPT_SCORE_NATIVE = 0.70
BOOST_ACCEPT_SCORE_CROSS = 0.65
BOOST_MAX_MATCHES_PER_TOPIC = 3

# memory-attribution (curator note → non-citable background context).
# Matched by trigger phrases AND note chunks against the user query. The bar
# sits high because a matched memory note is not advisory: the synthesis
# planner treats it as authoritative framing and anchors the whole outline to
# its steps (note step → thesis), so a loose match hijacks unrelated answers.
# On the live corpus the broad "structure of the Gita" note scores 0.58-0.61
# against existential queries ("who is God", "what is the soul") and 0.78-1.0
# against genuine structure paraphrases, including the cross-lingual sr-cyrl
# phrasing at 0.78. 0.75 native / 0.70 cross sits between the two bands. One
# memory per turn.
MEMORY_ACCEPT_SCORE_NATIVE = 0.75
MEMORY_ACCEPT_SCORE_CROSS = 0.70
MEMORY_MAX_MATCHES = 1
# Judge-gated memory (MEMORY_GATE). A matched memory note is AUTHORITATIVE — it
# anchors the whole outline — so cosine alone does not seat it. With the gate on,
# the cosine bars above are bypassed: every candidate above MEMORY_RECALL_FLOOR
# is routed through the cross-encoder/LLM judge ("does this curated note actually
# answer THIS question?"). Recall via a low cosine floor, precision via the
# judge — this scales as the curated-memory corpus grows (no per-note threshold
# tuning) and recovers genuine borderline / cross-lingual matches that a high
# cosine bar would drop. Set MEMORY_GATE=False to fall back to cosine thresholds.
MEMORY_RECALL_FLOOR = 0.55
MEMORY_GATE = True
# Cross-encoder accept bar for the judge-gated memory path. Higher than the
# pinned bar (PINNED_RERANK_ACCEPT=0.50): on the live "structure of the Gita"
# note, off-topic queries it half-matches ("who is God?") rerank at ~0.55
# while genuine structure questions hit 0.80-0.85 — 0.65 sits in that gap.
MEMORY_RERANK_ACCEPT = 0.65

# A matched memory whose curator refs RESOLVE to at least this many citable
# envelopes is a sufficient (CORRECT) answer on its own: the sufficiency gate
# takes the lean path (authoritative refs + bounded supplementary fanout)
# instead of the full LONG corpus sweep (100-200 sources). The curator picked
# exactly these shlokas for this note — stronger ground truth than any fanout
# pool — so the wide sweep is wasted latency once they resolve. Counts RESOLVED
# envelopes (a ref to a verse missing from the chunk repo doesn't count).
MEMORY_SUFFICIENT_REFS = 3

# Match-score bar a memory must clear to SHORT-CIRCUIT the corpus sweep (take
# the lean path). Strictly higher than the inject thresholds (0.60/0.55): a
# LOOSE memory match still injects its note as ambient background (cheap — the
# synthesizer just ignores an off-topic briefing) but must NOT change the
# retrieval path on a weak signal. On prod data genuine structure paraphrases
# score 0.72-1.0 and a false same-book match ("what is the soul" vs the
# structure memory) tops out ~0.57, so 0.70 separates them with margin. The
# asymmetry is deliberately safe — a borderline genuine match that dips below
# just reverts to the LONG path, where the memory refs STILL attach as
# authoritative and cite in full (only the latency win is lost, never quality).
MEMORY_CORRECT_SCORE_NATIVE = 0.70
MEMORY_CORRECT_SCORE_CROSS = 0.65

# Canonical score for a matched memory's refs in the citable pool — same flat
# value boost refs use (floats them above ordinary fanout without claiming
# pinned authority). Also the `top_score` default the lean fetch scores against
# on a memory-only CORRECT turn (no pinned match to take the max over).
MEMORY_REF_SCORE = 0.75

# Max planner rephrasings (sub-query texts + alt_phrasings) the memory lookup
# probes in addition to the raw query — each is one extra pgvector lookup, so
# bound it. Raw query + up to this many keeps latency in check.
MEMORY_SUBQUERY_CAP = 6
# Cross-encoder gate for fetched boost (topic-attribution) refs. boost matches
# come from the EXTRACTED-TOPIC embedding (not the user question) and are pinned
# at a flat 0.75 cosine that floats them above ordinary fanout, outside the
# reranker the rest of the LONG-path pool goes through. When a reranker
# is present, re-score each fetched topic ref against the USER QUESTION and drop
# the ones below this threshold, so a topic that matched a tangential angle of
# the question doesn't get pinned above on-topic fanout. Mirrors the verse/
# library reserve floor; only the boost path is gated (the normal fanout path is
# untouched). Reranker absent ⇒ no gate.
BOOST_REF_RERANK_ACCEPT = 0.40
TOPIC_MAX_TOPICS_EXTRACTED = 5         # cap on LLM output (query topic extraction)

# ---- Fanout / coverage -----------------------------------------------------

COVERAGE_MIN_MAX_SCORE = 0.55
COVERAGE_MIN_LECTURES = 2
MAX_FANOUT_ROUNDS = 2
TOPK_PER_QUERY = 8

# Round-1 (regenerate) fanout is bounded much tighter than round 0. Round 0
# fans out every sub_query × every alt_phrasing; replaying that breadth on the
# second pass blows the tail turn out (~11s round-1 vs ~5s round-0 in prod
# traces). The regenerate round only needs a few fresh angles, so it takes
# the primary text of the first N regenerated sub_queries and drop alt_phrasings.
REGEN_MAX_SUBQUERIES = 4

# The fanout's DB-concurrency ceiling is `Settings.fanout_db_concurrency`,
# handed in per turn — it has to be tuned together with `db_pool_max_size`,
# and an operator needs both without a rebuild. This is its default, for
# callers that run the pipeline outside a configured turn.
DEFAULT_FANOUT_DB_CONCURRENCY = 8

# Addresses ("БГ 2.13") parsed out of the RAW user query for the exact-match
# fast path. One fetch per address, up to two round-trips each, and the input
# is user-controlled — cap it so a question stuffed with references can't
# amplify into an unbounded burst.
MAX_PARSED_ADDRESSES = 8

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
RERANK_NOISE_PREFLOOR = 0.18  # permissive cosine pre-floor — drops pure garbage only;
                              # relevant verses often score ~0.30.

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

# ---- Hybrid lexical retrieval ----------------------------------------------
# A non-cosine recall lane (full-text + pg_trgm address) running ALONGSIDE the
# dense ANN. Catches what the English-centric embedder misses: canonical
# addresses ("БГ 2.13"), Sanskrit transliteration, and short verses. No rank
# fusion is performed: a lexical hit joins the pool as a `forced` member — it
# keeps its true (often low) cosine but bypasses the cosine floor — and the
# cross-encoder orders it from there. Active only on the rerank path (the
# lexical hit needs the reranker to re-score it on its text).
LEXICAL_FETCH_TOP_K = 24    # per-sub-query lexical fetch (mirror RERANK_FETCH_TOP_K);
                            # caps the lexical arm so it can't crowd the rerank pool.
LEXICAL_TRGM_MIN_SIM = 0.3  # pg_trgm similarity threshold for the address `%` match.
# Authoritative score for an EXACT address the user named in the query
# ("БГ 2.13"), fetched deterministically. Mirrors the SHORT-path question-ref
# convention (`canonical_score=0.85`) — an explicitly-named, existing verse is
# as authoritative as a curator question-attribution.
ADDRESS_HIT_SCORE = 0.85

# ---- Stage timeouts (asyncio.wait_for) -------------------------------------

# Sized for production, not localhost: 5 queries × {lecture, verse,
# commentary, prose} fanout = 20 parallel pgvector queries plus a batched
# OpenRouter embedding call. Localhost finishes in ~1s, AWS RDS + OpenRouter
# takes 6-10s on a cold pgvector cache.
TIMEOUT_PLAN_S = 8.0
TIMEOUT_QUESTION_LOOKUP_S = 6.0
TIMEOUT_TOPIC_EXTRACT_S = 8.0
TIMEOUT_TOPIC_LOOKUP_S = 6.0
TIMEOUT_MEMORY_LOOKUP_S = 6.0
TIMEOUT_FANOUT_S = 30.0
TIMEOUT_REGENERATE_S = 8.0
TIMEOUT_FETCH_REFS_S = 5.0
TIMEOUT_COMMENTARY_EXPAND_S = 5.0

# ---- Verse → commentary expansion -----------------------------------------

# Per verse hit, this is the upper bound on how many commentary chunks
# get attached. Authors-first selection means up to N distinct purports
# appear before any second segment from one author.
MAX_COMMENTARIES_PER_VERSE = 12

# Stage 1 (synthesis_planner) attach is per-thesis and scoped to the verses
# the planner actually picked, so a handful of purports per picked verse is
# plenty for the reranker to pick the one that backs the thesis. The small cap
# keeps the appended pool (and the embed/rerank cost) bounded.
STAGE1_COMMENTARIES_PER_VERSE = 4

# Cosine floor for an AUTO-ATTACHED purport to be eligible as a thesis's
# supporting note. The planner's OWN picks are never gated by this (they
# were vetted by the reasoner that read the full text); only the
# commentaries we attach on top of a picked verse must clear it, so an
# off-topic purport on an otherwise-relevant verse can't pad the citation.
# Below RERANK_RESERVE_FLOOR (0.40) because thesis↔short-purport cosine
# runs lower than query↔chunk cosine; calibrate from per_thesis logs.
STAGE1_ATTACH_FLOOR = 0.30


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

# Stage 2 ANN budget, enforced by `asyncio.wait_for` around EACH thin thesis's
# fresh fetch in `augment_thin_theses` — avoids a runaway if pgvector hangs.
# Per-thesis, not fan-out-wide, so one slow shard only costs its own thesis;
# the theses that answered keep their fresh chunks. On expiry that thesis
# degrades to `fetch_failed` and keeps Stage 1's picks.
#
# Sized by shape, not from production timings: one thin thesis costs a
# `filter_track_ids` lookup, two concurrent pgvector ANN queries and an
# author-name resolve — the same single-round DB work as TIMEOUT_FETCH_REFS_S /
# TIMEOUT_COMMENTARY_EXPAND_S (5.0), plus a second of head-room because it runs
# on a cold-ish cache after retrieval is over. Not sized like TIMEOUT_FANOUT_S
# (30.0), which covers the whole multi-round fan-out (MAX_FANOUT_ROUNDS ×
# sub-queries × kinds, embed and rerank included). `augment_summary` logs
# `fetch_ms` per thesis and `fetch_ms_max` for the turn; set this from their
# p95.
TIMEOUT_AUGMENT_S = 6.0


# ---- Retrieval policy (sufficiency-gated path presets) ---------------------
# The SHORT/LONG paths are the LEAN/WIDE presets of one policy object:
# `assess_sufficiency` buckets the turn (CORRECT/INCORRECT) and `policy_for`
# maps the bucket to a preset that both retrieval paths read their knobs from.
# Only knobs that are actually wired live here.


@dataclass(frozen=True)
class RetrievalPolicy:
    """How a turn retrieves, once the sufficiency gate has bucketed it.

    `wide_fanout` picks the path: LEAN = curated authoritative refs + a bounded
    supplementary fanout (the SHORT path); WIDE = topic extraction + boosted
    full-plan fanout with coverage-gated rounds (the LONG path)."""

    name: str
    wide_fanout: bool
    slate_size: int               # cap on the research_chunks pool handed to the planner
    supplementary_subqueries: int # LEAN: how many sub_queries' primary text to fan out
    max_fanout_rounds: int        # WIDE: coverage-gated fanout rounds (0 on LEAN)


LEAN_POLICY = RetrievalPolicy(
    name="lean", wide_fanout=False, slate_size=8,
    supplementary_subqueries=3, max_fanout_rounds=0,
)
WIDE_POLICY = RetrievalPolicy(
    name="wide", wide_fanout=True, slate_size=20,
    supplementary_subqueries=0, max_fanout_rounds=MAX_FANOUT_ROUNDS,
)
