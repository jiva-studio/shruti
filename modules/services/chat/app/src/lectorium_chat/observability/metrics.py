"""Prometheus metrics for the chat service.

Single module-level registry so counters/gauges are import-safe and
re-importable in tests (process-wide singleton). Counters defined here
land in the default `prometheus_client.REGISTRY`, exposed at `/metrics`
(mounted as a sub-app in `main.py`) for Prometheus to scrape.

Importing this module is side-effect-only (no setup function needed).
Test code that wants a clean slate per-test can do
`counter._metrics.clear()` on the affected counter to reset its
samples — see `tests/application/test_rate_limiter_fail_closed.py`.
"""

from __future__ import annotations

from prometheus_client import Counter


# Increments every time the rate-limit store raises
# `RateLimitStoreUnavailable` during a rate-limit check. The `tier` label
# lets us split the "Pro went brownout" (degraded but allowed) signal
# from the "non-Pro got 503" (fail-closed) signal in Grafana.
#
# Cardinality is bounded: {anonymous, free, pro}. No user-derived
# labels — that would blow the time-series count. (The metric series
# name keeps the historical `redis` token so existing dashboards/alerts
# don't break.)
redis_unavailable_counter = Counter(
    "lectorium_chat_rate_limit_redis_unavailable_total",
    "Rate-limit store-unavailable occurrences during rate-limit checks, by tier",
    labelnames=["tier"],
)


# Increments on every 429 the application-layer rate-limiter emits.
# (Caddy proxy 429s — e.g. `/auth/anonymous` throttle — are NOT counted
# here; they're observable via Caddy's access log.)
#
# Labels:
#   scope     — `chat` / `title` / `questions` / `feedback`. Lets us
#               split user-facing chat throttles from cheap-call
#               throttles in Grafana.
#   key_type  — `user` (per-quota_id) / `ip` (per-IP). Tells us whether
#               the same user is hammering or a CGNAT peer storm hit
#               the IP cap.
#   tier      — `anonymous` / `free` / `pro`. The echoed-tier value
#               (already accounts for stale-Pro downgrade), matching
#               the 429 body the mobile UX keys off.
#
# Cardinality bound: 4 scopes × 2 key_types × 3 tiers = 24 series. Safe.
# No user_id / ip in labels — that would explode cardinality.
rate_limit_hits_counter = Counter(
    "lectorium_chat_rate_limit_hits_total",
    "Application-layer 429 rate-limit responses, by scope/key/tier",
    labelnames=["scope", "key_type", "tier"],
)


# Increments every time the out-of-corpus memory-pass fallback fires (the
# corpus had nothing relevant). This IS the corpus-gap signal: each increment
# is a question the lecture/book corpus couldn't answer, so a rising
# `kind=memory` rate points curation (pinned/boost/memory attributions) at the
# topics users actually ask about.
#
# Labels:
#   kind            — `memory` (answered from general knowledge) /
#                     `out_of_scope` (declined: unrelated to the corpus
#                     domain) / `degraded` (no LLM / call failed → normal refusal).
#   confidence      — model's self-assessed certainty `high`/`medium`/`low`
#                     (`na` for out_of_scope / degraded).
#   had_corpus_hits — `yes` if the answer-derived re-search surfaced any
#                     score-floored notes, else `no`.
#
# Cardinality bound: 3 kinds × 4 confidences × 2 = 24 series. No user text.
corpus_fallback_counter = Counter(
    "lectorium_chat_corpus_fallback_total",
    "Out-of-corpus memory-pass fallbacks, by kind/confidence/corpus-hit",
    labelnames=["kind", "confidence", "had_corpus_hits"],
)
