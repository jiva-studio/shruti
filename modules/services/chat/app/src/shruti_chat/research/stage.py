"""One research stage: a stage timeout, the degradation rule and its telemetry."""

from __future__ import annotations

import asyncio
from time import perf_counter
from typing import Any

from shruti_chat.domain.ports.llm_provider import provider_unavailable
from shruti_chat.observability.langfuse_client import langfuse_span
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.metrics import pipeline_stage_counter

log = get_logger(__name__)


# Stage outcomes that are NOT a clean run. Langfuse renders WARNING-level
# observations distinctly, so a degraded stage is visible while scanning a
# trace rather than only when you go looking for it.
_DEGRADED_STAGE_STATUSES = frozenset({"timeout", "error", "provider_unavailable"})


def _mark_span(span: Any, *, status: str, stage_ms: float) -> None:
    """Record a stage's outcome on its Langfuse span. Best-effort: telemetry
    must never break a turn, and the span is None whenever Langfuse is off."""
    if span is None:
        return
    try:
        span.update(
            metadata={"status": status, "stage_ms": stage_ms},
            level="WARNING" if status in _DEGRADED_STAGE_STATUSES else "DEFAULT",
            status_message=status if status in _DEGRADED_STAGE_STATUSES else None,
        )
    except Exception as exc:  # noqa: BLE001 — telemetry never breaks a turn
        log.warning("langfuse_span_update_failed", stage=status, error=str(exc))


async def run_stage(coro_factory, *, default, timeout: float, name: str, request_id: str | None):
    """Run a coroutine with a stage timeout; on TimeoutError / any exception,
    return `default` so the orchestrator can keep going with partial state.

    Emits `stage_timing {stage, stage_ms, status}` on every outcome so the
    research pipeline is fully covered by the same instrumentation as the
    rest of the turn — without having to wrap each call site separately.
    Also opens a Langfuse span (`retrieval.<stage>`) so the same per-stage
    timing shows up in the trace timeline next to the LLM generations.

    EXCEPTION: a provider-availability failure (out of credits / key rejected
    / provider down) is NOT swallowed. Degrading it to `default` here would
    hand the synthesizer empty grounding and produce a confident-looking but
    ungrounded partial answer — worse than telling the user the service is
    momentarily unavailable. It re-raises so `chat_turn` classifies it as a
    calm `chat_unavailable`, not `agent_error`. A transient blip in ONE stage
    (timeout, a single ANN error) still degrades gracefully.
    """
    started = perf_counter()
    status = "ok"
    with langfuse_span(f"retrieval.{name}") as span:
        try:
            return await asyncio.wait_for(coro_factory(), timeout=timeout)
        except asyncio.TimeoutError:
            status = "timeout"
            log.warning("pipeline_stage_timeout", stage=name, timeout=timeout, request_id=request_id)
            return default
        except Exception as exc:  # noqa: BLE001 — best-effort
            if provider_unavailable(exc):
                status = "provider_unavailable"
                log.warning(
                    "pipeline_stage_provider_unavailable",
                    stage=name, error=str(exc), request_id=request_id,
                )
                raise
            status = "error"
            # Unlike the timeout / provider-unavailable branches above,
            # this one is unexplained — carry the traceback.
            log.warning(
                "pipeline_stage_error",
                stage=name, error=str(exc), request_id=request_id, exc_info=True,
            )
            return default
        finally:
            stage_ms = round((perf_counter() - started) * 1000, 1)
            log.info(
                "stage_timing",
                stage=name,
                stage_ms=stage_ms,
                status=status,
                request_id=request_id,
            )
            # Put the outcome ON the span too. Without it a degraded stage is
            # indistinguishable from a fast one in the trace — the span just
            # ends — and the timeout would only be visible in Loki, a
            # different tool from the trace you are reading.
            _mark_span(span, status=status, stage_ms=stage_ms)
            pipeline_stage_counter.labels(stage=name, status=status).inc()
