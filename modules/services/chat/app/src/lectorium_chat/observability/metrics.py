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

from prometheus_client import REGISTRY, Counter, Gauge
from prometheus_client.core import GaugeMetricFamily


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


# ── Process state ─────────────────────────────────────────────────────
#
# Per-TURN signals (latency, TTFT, tokens, cost, per-stage timings) already
# reach Langfuse and Loki, and are not duplicated here. What follows is the
# class those cannot express: state of THIS process, aggregated across turns.
# It is what tells you a pile-up is forming before users feel it.
#
# Single uvicorn worker (no --workers), so a default-registry gauge is
# process-truthful. If workers are ever added these need
# PROMETHEUS_MULTIPROC_DIR, and the custom collector below stops working
# entirely under multiprocess mode.


# Detached turn producers currently running. Set (not inc/dec) at the two
# mutation points so it self-heals rather than drifting if an exit path is
# ever added without a decrement. Initialised so the series exists before the
# first turn — otherwise `absent()` alerts fire on a fresh pod.
turns_in_flight = Gauge(
    "lectorium_chat_turns_in_flight",
    "Detached chat-turn producers currently running on this replica",
)
turns_in_flight.set(0)


# How a turn ended. `error` after the answer started is a materially different
# incident from a blank one, hence the second label.
# Cardinality: 3 states x 2 = 6 series.
turn_terminal_counter = Counter(
    "lectorium_chat_turn_terminal_total",
    "Chat turns by terminal state and whether any answer content streamed",
    labelnames=["state", "answer_started"],
)


# Retrieval stage outcomes. Counting timeouts alone gives a numerator with no
# denominator; {stage,status} gives the RATE, which is what you alert on.
# Cardinality: ~14 stage names (all string literals in pipeline.py) x 4
# statuses = 56 series, closed set, no user input.
pipeline_stage_counter = Counter(
    "lectorium_chat_pipeline_stage_total",
    "Research-pipeline stage completions by stage and outcome",
    labelnames=["stage", "status"],
)


# LLM retry ladder. Every site already logs; none counted, so "OpenRouter
# error rate spiked" was not alertable.
#
# NO `model` label, deliberately: `_validate_model` passes unrecognised model
# ids through on purpose so a Langfuse prompt-config edit takes effect without
# a deploy — which makes `model` operator-typeable and unbounded, and one typo
# in the UI would mint a permanent time series. The exact model is already on
# every Langfuse generation.
# Cardinality: 3 call kinds x 6 reasons = 18 series.
llm_retry_counter = Counter(
    "lectorium_chat_llm_retry_total",
    "Same-model LLM retries, by call kind and why the attempt failed",
    labelnames=["call", "reason"],
)

# `escalated` counts every fallback-model attempt, `exhausted` the ones where
# the fallback ALSO failed — the ratio is how often the safety net didn't
# catch. Cardinality: 3 x 2 = 6 series.
llm_fallback_counter = Counter(
    "lectorium_chat_llm_fallback_total",
    "Escalations to the fallback model, by call kind and outcome",
    labelnames=["call", "outcome"],
)


# The asyncpg pool has no mutation point to hook — the alternative is wrapping
# every `pool.acquire()`, which is dozens of call sites all on the hot path.
# A scrape-time collector costs O(max_size) per scrape and nothing per request.
class _DbPoolCollector:
    """Samples the connection pool when Prometheus scrapes.

    `size - idle` is in-use; saturation is `(size - idle) / max`. `waiters` is
    the one that distinguishes "healthily busy" from "requests queueing" —
    `size == max` alone cannot — and it is also the fragile one: asyncpg
    exposes no public waiter count, so it reads two levels of private state
    and is simply omitted when that fails.
    """

    def collect(self):
        # Imported lazily so this module stays standalone-importable (a test
        # imports it on its own) and free of import-order surprises.
        from lectorium_chat.db import client as db_client

        pool = getattr(db_client, "_pool", None)
        if pool is None:
            return
        try:
            size = pool.get_size()
            idle = pool.get_idle_size()
            maximum = pool.get_max_size()
        except Exception:  # noqa: BLE001 — a scrape must never raise
            return
        yield GaugeMetricFamily(
            "lectorium_chat_db_pool_size", "Open pool connections", value=size,
        )
        yield GaugeMetricFamily(
            "lectorium_chat_db_pool_idle", "Idle pool connections", value=idle,
        )
        yield GaugeMetricFamily(
            "lectorium_chat_db_pool_max", "Configured pool ceiling", value=maximum,
        )
        try:
            waiters = len(pool._queue._getters)
        except Exception:  # noqa: BLE001 — private on two levels; optional
            return
        yield GaugeMetricFamily(
            "lectorium_chat_db_pool_waiters",
            "Coroutines waiting for a free pool connection",
            value=waiters,
        )


# `register` calls `collect()` once immediately for the duplicate-name check,
# so `collect` must tolerate a pool that does not exist yet.
REGISTRY.register(_DbPoolCollector())


# Which SOURCE served each prompt fetch. `LangfusePromptHandle.from_langfuse`
# has existed all along, documented as the signal "operators can spot when
# prompts are being served stale" — with zero readers. So during a Langfuse
# outage the service silently reverted every prompt to whatever was baked into
# the image (arbitrarily far behind the live copy, since `pull` is manual) and
# nothing said so.
#
# Cardinality: 28 registered prompts x 2 sources = 56 series, closed set.
prompt_fetch_counter = Counter(
    "lectorium_chat_prompt_fetch_total",
    "Prompt fetches by name and where the text came from",
    labelnames=["name", "source"],
)


def prompt_source_summary() -> dict[str, object]:
    """Per-source fetch tallies for `/status`.

    Reads the counter rather than keeping a second tally, so the endpoint and
    the metric can never disagree. `fallback_names` is the actionable part: a
    non-empty list means those prompts are being served from the image copy,
    which `pull` only refreshes manually.
    """
    langfuse_total = 0.0
    fallback_total = 0.0
    fallback_names: set[str] = set()
    for metric in prompt_fetch_counter.collect():
        for sample in metric.samples:
            if not sample.name.endswith("_total"):
                continue
            source = sample.labels.get("source")
            if source == "langfuse":
                langfuse_total += sample.value
            elif source == "fallback" and sample.value:
                fallback_total += sample.value
                fallback_names.add(sample.labels.get("name", "?"))
    return {
        "fetches_from_langfuse": int(langfuse_total),
        "fetches_from_fallback": int(fallback_total),
        "serving_from_fallback": sorted(fallback_names),
    }
