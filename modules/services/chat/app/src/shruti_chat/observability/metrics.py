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


# Increments every time the Redis-backed rate-limit store raises
# `RedisUnavailableError` during a rate-limit check. The `tier` label
# lets us split the "Pro went brownout" (degraded but allowed) signal
# from the "non-Pro got 503" (fail-closed) signal in Grafana.
#
# Cardinality is bounded: {anonymous, free, pro}. No user-derived
# labels — that would blow the time-series count.
redis_unavailable_counter = Counter(
    "shruti_chat_rate_limit_redis_unavailable_total",
    "RedisUnavailableError occurrences during rate-limit checks, by tier",
    labelnames=["tier"],
)
