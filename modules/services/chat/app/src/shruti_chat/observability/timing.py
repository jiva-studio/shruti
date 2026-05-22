"""Per-stage timing instrumentation.

Use `stage(name, **extra)` as an async context manager around any awaitable
work to log a `stage_timing` event with `stage_ms`. The structlog context
(`trace_id`, `request_id`, `agent_role`) is inherited automatically so
timings from different nodes of one chat turn correlate by `trace_id`.

Sampling is deterministic per `trace_id`: a turn is either fully sampled
(all stages logged) or fully skipped. This keeps the breakdown of any one
turn coherent and avoids "half-instrumented" turns that would confuse
percentile analysis.
"""

from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from time import perf_counter
from typing import Any, AsyncIterator

import structlog

from shruti_chat.config import get_settings


log = structlog.get_logger(__name__)


def _is_sampled() -> bool:
    settings = get_settings()
    if not settings.stage_timing_enabled:
        return False
    rate = settings.stage_timing_sample_rate
    if rate >= 1.0:
        return True
    if rate <= 0.0:
        return False
    trace_id = structlog.contextvars.get_contextvars().get("trace_id")
    if not trace_id:
        # No turn context bound — fall back to rate-only Bernoulli would be
        # non-deterministic; safer to log so we don't silently drop edge cases.
        return True
    bucket = int(hashlib.blake2b(trace_id.encode("utf-8"), digest_size=2).hexdigest(), 16)
    return (bucket % 10000) < int(rate * 10000)


@asynccontextmanager
async def stage(name: str, **extra: Any) -> AsyncIterator[None]:
    """Measure the wrapped awaitable and emit `stage_timing {stage, stage_ms}`.

    Always logs on both success and exception paths (the exception still
    propagates). Use for any unit of latency you want broken out in
    p50/p95 analysis later.
    """
    if not _is_sampled():
        yield
        return
    started = perf_counter()
    status = "ok"
    try:
        yield
    except BaseException:
        status = "error"
        raise
    finally:
        elapsed_ms = round((perf_counter() - started) * 1000, 1)
        log.info("stage_timing", stage=name, stage_ms=elapsed_ms, status=status, **extra)
