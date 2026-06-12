"""Application service that runs a chat turn DETACHED from the request.

`run_chat_turn` produces a turn's event stream; this service is what *hosts*
that stream as a background task which outlives the client socket — so the
answer is buffered for resume (see `TurnStore`) even after the client
backgrounds / disconnects. It spawns the task, tails its events into a queue
the SSE response reads, writes the event buffer + heartbeat to the store, and
tracks the in-process cancel registry.

Keeping the lifecycle here — an injectable service on `AppDeps` — instead of
as module-level globals in the API route keeps the route to
parse/validate/auth/respond and makes the producer testable in isolation.
The caller supplies two turn-specific closures: a `stream_factory` (builds
the event stream given the runner's cancel predicate) and a `finalize` hook
(quota refund / idempotency release / usage frame, once the turn ends).
"""

from __future__ import annotations

import asyncio
import json
from time import perf_counter
from typing import Any, AsyncIterator, Awaitable, Callable

from shruti_chat.agent.events import AgentEvent
from shruti_chat.domain.ports.turn_store import TurnStore
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

_HEARTBEAT_INTERVAL_S = 30

# Builds the turn's event stream given the runner's cancel predicate — the
# runner owns the cancel state, the caller owns which turn (chat / proactive)
# to run.
StreamFactory = Callable[[Callable[[], Awaitable[bool]]], AsyncIterator[AgentEvent]]
# Turn-specific teardown: (had_error, completed) → the usage frame to append,
# or None. Does quota refund / idempotency release as a side effect.
Finalize = Callable[[bool, bool], Awaitable["dict[str, Any] | None"]]


class TurnRunner:
    def __init__(self, turn_store: TurnStore) -> None:
        self._turn_store = turn_store
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancels: dict[str, asyncio.Event] = {}

    async def shutdown(self) -> None:
        """Cancel in-flight producer tasks on lifespan teardown so a redeploy
        terminates deterministically instead of abandoning detached tasks. Any
        turn cut short here leaves its short-lived `running` marker to lapse,
        and the client reads it as orphaned on resume (the designed fallback)."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def cancel(self, trace_id: str) -> None:
        """Explicit Stop — cancel the producer on this replica (fast) and set
        the cross-replica flag in case it runs on another replica."""
        local = self._cancels.get(trace_id)
        if local is not None:
            local.set()
        await self._turn_store.request_cancel(trace_id)

    def start(
        self,
        trace_id: str,
        user_id: str,
        *,
        stream_factory: StreamFactory,
        finalize: Finalize,
    ) -> "asyncio.Queue[dict[str, Any] | None]":
        """Spawn the detached producer and return the queue the SSE response
        tails. The producer keeps running if the SSE consumer drops (client
        disconnect / background) — only `cancel()` stops it early."""
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        cancel_event = asyncio.Event()
        self._cancels[trace_id] = cancel_event

        async def is_cancelled() -> bool:
            # Explicit cancel only — NOT socket disconnect. Fast in-process
            # event OR the cross-replica Redis flag.
            if cancel_event.is_set():
                return True
            return await self._turn_store.is_cancelled(trace_id)

        async def produce() -> None:
            # `error` frame drives refund + idempotency release. `completed`
            # is set only after the stream drains normally, so a CancelledError
            # (shutdown) persists as `error`, never a truncated `done`.
            had_error = False
            completed = False
            buffer: list[dict[str, Any]] = []
            await self._turn_store.mark_running(trace_id, user_id)
            try:
                stream = stream_factory(is_cancelled)
                last_heartbeat = perf_counter()
                async for ev in stream:
                    if ev.type == "error":
                        had_error = True
                    frame = {
                        "event": ev.type,
                        "data": json.dumps(ev.data, ensure_ascii=False),
                    }
                    buffer.append(frame)
                    await queue.put(frame)
                    now = perf_counter()
                    if now - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                        await self._turn_store.heartbeat(trace_id)
                        last_heartbeat = now
                completed = True
            except Exception:
                had_error = True
                log.exception("chat_turn_producer_failed", trace_id=trace_id)
            finally:
                # finalize() does quota/idempotency accounting. Guard it so a
                # raise here can't skip the sentinel below — otherwise an
                # attached SSE consumer would block on the queue until its ping
                # timeout, and the turn would never be buffered for resume.
                try:
                    usage_frame = await finalize(had_error, completed)
                except Exception:
                    log.exception("chat_turn_finalize_failed", trace_id=trace_id)
                    usage_frame = None
                if usage_frame is not None:
                    buffer.append(usage_frame)
                    await queue.put(usage_frame)
                await self._turn_store.finish(
                    trace_id,
                    state="error" if (had_error or not completed) else "done",
                    events=buffer,
                    user_id=user_id,
                )
                # Sentinel — unblocks the SSE consumer if still attached.
                await queue.put(None)
                self._tasks.pop(trace_id, None)
                self._cancels.pop(trace_id, None)

        task = asyncio.create_task(produce())
        self._tasks[trace_id] = task
        return queue
