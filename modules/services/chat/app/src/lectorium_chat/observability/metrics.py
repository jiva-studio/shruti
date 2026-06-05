"""Prometheus metrics for the chat service.

Single module-level registry so counters/gauges are import-safe and
re-importable in tests (process-wide singleton). The chat service does
not yet expose a `/metrics` endpoint — counters defined here land in
the default `prometheus_client.REGISTRY` and will be scraped once
PR-5 wires the HTTP exporter. Defining them now keeps the production
code path observable without waiting for the exporter.

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
