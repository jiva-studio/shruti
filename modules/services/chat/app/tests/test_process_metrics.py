"""Process-state metrics: what per-trace telemetry structurally cannot say.

Latency, TTFT, tokens, cost and per-stage timings already reach Langfuse and
Loki — a trace describes ONE turn. None of them can answer "how many turns are
running right now", "is the connection pool queueing", "has the LLM error rate
moved". Those are properties of the process, aggregated across turns, and they
are the leading indicators for every load risk in this service.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from prometheus_client import generate_latest

from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.observability import metrics as metrics_mod
from lectorium_chat.research import pipeline as pipeline_mod


class _FakeTurnStore:
    def __init__(self) -> None:
        self.finished: dict[str, dict[str, Any]] = {}

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(self, trace_id: str, *, state: str, events, user_id: str) -> None:
        self.finished[trace_id] = {"state": state}

    async def get(self, trace_id: str):
        return None

    async def request_cancel(self, trace_id: str) -> None:
        return None

    async def is_cancelled(self, trace_id: str) -> bool:
        return False


class _Ev:
    def __init__(self, type_: str, data: dict) -> None:
        self.type = type_
        self.data = data


def _counter_value(counter, **labels) -> float:
    return counter.labels(**labels)._value.get()


async def _noop_finalize(had_error: bool, completed: bool, answer_started: bool):
    return None


async def _drain(queue: asyncio.Queue) -> None:
    while await queue.get() is not None:
        pass


# ── in-flight gauge ─────────────────────────────────────────────────────


async def test_in_flight_gauge_tracks_running_turns() -> None:
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=0)
    release = asyncio.Event()

    def factory(is_cancelled):
        async def _held():
            await release.wait()
            return
            yield  # pragma: no cover — makes this an async generator

        return _held()

    queues = [
        runner.start(f"t{i}", "u", stream_factory=factory, finalize=_noop_finalize)
        for i in range(3)
    ]
    await asyncio.sleep(0)
    assert metrics_mod.turns_in_flight._value.get() == 3

    release.set()
    for q in queues:
        await _drain(q)
    # Set, not decremented — it self-heals rather than drifting if an exit
    # path is ever added without a matching decrement.
    assert metrics_mod.turns_in_flight._value.get() == 0


# ── terminal state ──────────────────────────────────────────────────────


async def test_terminal_counter_separates_error_after_answer() -> None:
    """A turn that failed AFTER streaming answer content is a different
    incident from one that produced nothing."""
    runner = TurnRunner(_FakeTurnStore(), max_in_flight=0)
    before = _counter_value(
        metrics_mod.turn_terminal_counter, state="error", answer_started="yes",
    )

    def factory(is_cancelled):
        async def _partial():
            yield _Ev("delta", {"text": "half an "})
            yield _Ev("error", {"code": "agent_error"})

        return _partial()

    await _drain(
        runner.start("t-err", "u", stream_factory=factory, finalize=_noop_finalize)
    )

    after = _counter_value(
        metrics_mod.turn_terminal_counter, state="error", answer_started="yes",
    )
    assert after == before + 1


# ── pipeline stages ─────────────────────────────────────────────────────


async def test_stage_counter_records_both_outcomes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Counting timeouts alone gives a numerator with no denominator; the
    alertable signal is the RATE, so successes are counted too."""
    from contextlib import contextmanager

    @contextmanager
    def _no_span(name: str):
        yield None

    monkeypatch.setattr(pipeline_mod, "langfuse_span", _no_span)

    ok_before = _counter_value(
        metrics_mod.pipeline_stage_counter, stage="embed", status="ok",
    )
    timeout_before = _counter_value(
        metrics_mod.pipeline_stage_counter, stage="embed", status="timeout",
    )

    async def _work():
        return "v"

    async def _slow():
        await asyncio.sleep(5)

    await pipeline_mod._safe(_work, default=None, timeout=5.0, name="embed", request_id="r")
    await pipeline_mod._safe(_slow, default=None, timeout=0.01, name="embed", request_id="r")

    assert _counter_value(
        metrics_mod.pipeline_stage_counter, stage="embed", status="ok",
    ) == ok_before + 1
    assert _counter_value(
        metrics_mod.pipeline_stage_counter, stage="embed", status="timeout",
    ) == timeout_before + 1


# ── LLM retry reasons ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (Exception("who knows"), "other"),
    ],
)
def test_retry_reason_buckets_are_closed(exc: Exception, expected: str) -> None:
    from lectorium_chat.infra.llm_provider.openrouter import _retry_reason

    assert _retry_reason(exc) == expected


def test_retry_reason_reads_the_in_band_status() -> None:
    """OpenRouter delivers mid-stream errors in-band on a 200, so the reason
    has to come from the payload, not the exception type."""
    from lectorium_chat.infra.llm_provider.openrouter import _retry_reason

    class _InBand(Exception):
        def __init__(self) -> None:
            super().__init__("rate limited")
            self.status_code = 429

    assert _retry_reason(_InBand()) == "rate_limited"

    class _ServerError(Exception):
        def __init__(self) -> None:
            super().__init__("bad gateway")
            self.status_code = 502

    assert _retry_reason(_ServerError()) == "server_error"


def test_llm_counters_carry_no_model_label() -> None:
    """`_validate_model` passes unrecognised model ids through on purpose so a
    Langfuse prompt-config edit takes effect without a deploy. That makes
    `model` operator-typeable and unbounded — one typo in the UI would mint a
    permanent time series."""
    assert "model" not in metrics_mod.llm_retry_counter._labelnames
    assert "model" not in metrics_mod.llm_fallback_counter._labelnames


# ── exposition ──────────────────────────────────────────────────────────


def test_new_series_are_exposed() -> None:
    body = generate_latest().decode()
    for name in (
        "lectorium_chat_turns_in_flight",
        "lectorium_chat_turn_terminal_total",
        "lectorium_chat_pipeline_stage_total",
        "lectorium_chat_llm_retry_total",
        "lectorium_chat_llm_fallback_total",
    ):
        assert name in body, f"{name} missing from /metrics"


def test_pool_collector_survives_a_missing_pool() -> None:
    """`REGISTRY.register` calls `collect()` immediately for its duplicate-name
    check, and scrapes happen before the pool exists during startup."""
    from lectorium_chat.db import client as db_client

    assert getattr(db_client, "_pool", None) is None
    # Must not raise, and must simply omit the families.
    assert "lectorium_chat_db_pool_size" not in generate_latest().decode()
