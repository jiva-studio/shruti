"""A stage timeout must actually bound the stage.

`_safe` runs each stage under `asyncio.wait_for`, which enforces its budget by
cancelling the wrapped coroutine. The speculative-embed helpers used to catch
`asyncio.CancelledError` alongside `Exception`, so they ate the timeout's own
cancellation and started a *fresh* embed. `Timeout.__aexit__` then saw a plain
value, called `uncancel()`, and reported the stage as `status="ok"` — a 0.5 s
budget observed running 2.5 s in production.

The same swallow absorbed an outer cancellation, defeating both an explicit
Stop and the 300 s `turn_budget_s` wall clock — the only thing bounding billed
LLM generation on an abandoned turn.
"""

from __future__ import annotations

import asyncio
from time import perf_counter

import pytest
from prometheus_client import REGISTRY

from shruti_chat.research import locate as locate_mod
from shruti_chat.research import pipeline as pipeline_mod

_STAGE_TOTAL = "shruti_chat_pipeline_stage_total"


def _stage_count(stage: str, status: str) -> float:
    value = REGISTRY.get_sample_value(_STAGE_TOTAL, {"stage": stage, "status": status})
    return value or 0.0


class _SlowEmbedder:
    """Stands in for the re-embed fallback: slower than any stage budget."""

    def __init__(self) -> None:
        self.calls = 0

    async def embed_query(self, question: str) -> list[float]:
        self.calls += 1
        await asyncio.sleep(2.0)
        return [0.1, 0.2]


async def test_stage_timeout_bounds_the_speculative_embed() -> None:
    """The three obvious asserts — default returned, fast, no re-embed — are all
    satisfied by *any* stage failure, so they cannot tell a fixed swallow from a
    helper that simply blew up. The load-bearing asserts are the two below them:
    the timeout's cancellation reached the speculative task, and `_safe` booked
    the stage as `status="timeout"` rather than `status="error"`.
    """
    stage = "embed_user_query"
    timeouts_before = _stage_count(stage, "timeout")
    errors_before = _stage_count(stage, "error")

    embedder = _SlowEmbedder()
    hanging = asyncio.create_task(asyncio.sleep(30))

    started = perf_counter()
    got = await pipeline_mod._safe(
        lambda: pipeline_mod._await_precomputed_embedding(hanging, embedder, "q"),
        default=None, timeout=0.2, name=stage, request_id="r",
    )
    elapsed = perf_counter() - started
    await asyncio.sleep(0)

    assert got is None, "the timed-out stage must degrade to its default"
    assert elapsed < 1.0, f"0.2s budget overrun: stage ran {elapsed:.2f}s"
    assert embedder.calls == 0, "the timeout must not kick off a fresh embed"
    assert hanging.cancelled(), (
        "the stage budget must cancel the speculative embed, not swallow the "
        "cancellation and leave the task running"
    )
    assert _stage_count(stage, "timeout") == timeouts_before + 1, (
        "the stage must be recorded as a timeout"
    )
    assert _stage_count(stage, "error") == errors_before, (
        "the stage must time out, not raise"
    )


async def test_outer_cancellation_propagates_through_the_speculative_embed() -> None:
    embedder = _SlowEmbedder()
    hanging = asyncio.create_task(asyncio.sleep(30))

    task = asyncio.create_task(
        pipeline_mod._await_precomputed_embedding(hanging, embedder, "q"),
    )
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    hanging.cancel()


async def test_locate_embed_helper_propagates_outer_cancellation() -> None:
    embedder = _SlowEmbedder()
    hanging = asyncio.create_task(asyncio.sleep(30))

    task = asyncio.create_task(
        locate_mod._await_embedding("q", embedder, hanging),
    )
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    hanging.cancel()


async def test_failed_speculative_task_still_falls_back_to_a_fresh_embed() -> None:
    """The carve-out the broad except was there for must keep working."""

    async def _boom() -> list[float]:
        raise RuntimeError("speculative embed died")

    embedder = _SlowEmbedder()
    failed = asyncio.create_task(_boom())

    got = await pipeline_mod._safe(
        lambda: pipeline_mod._await_precomputed_embedding(failed, embedder, "q"),
        default=None, timeout=5.0, name="embed_user_query", request_id="r",
    )

    assert got == [0.1, 0.2]
    assert embedder.calls == 1
