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
from time import monotonic
from typing import Any, AsyncIterator, Awaitable, Callable

from lectorium_chat.agent.events import AgentEvent
from lectorium_chat.domain.ports.turn_store import TurnStore
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)

_HEARTBEAT_INTERVAL_S = 30

# How often the CROSS-REPLICA cancel flag is read. The in-process event is
# still checked on every call, so a Stop that lands on this replica — which is
# every Stop on a single-replica deploy — still takes effect immediately. Only
# a Stop routed elsewhere waits this long.
#
# The predicate runs after every streamed event, including every token delta,
# so an unthrottled read was one Redis `EXISTS` per token: a 1500-token answer
# cost 1500 round-trips to the instance that also holds the KV cache, the
# rate-limit counters, the idempotency keys and the turn buffers, behind a
# 0.2s socket timeout. That traffic is what pushes the instance toward the
# timeout, and none of it carries information — the answer is "no" until the
# user presses Stop.

# Builds the turn's event stream given the runner's cancel predicate — the
# runner owns the cancel state, the caller owns which turn (chat / proactive)
# to run.
StreamFactory = Callable[[Callable[[], Awaitable[bool]]], AsyncIterator[AgentEvent]]
# Turn-specific teardown: (had_error, completed, answer_started) → the usage
# frame to append, or None. Does quota refund / idempotency release as a side
# effect. `answer_started` is True once any user-visible answer `delta` has been
# pushed to the client, so finalize() can refuse to refund a Stop that landed
# after the answer already streamed.
Finalize = Callable[[bool, bool, bool], Awaitable["dict[str, Any] | None"]]


class TurnCapacityExceeded(RuntimeError):
    """Too many turns already in flight on this replica.

    Raised by `start()` BEFORE the producer is spawned, so the caller still
    owns the quota charge and the idempotency key and can undo both."""


class TurnRunner:
    def __init__(
        self,
        turn_store: TurnStore,
        *,
        max_in_flight: int = 24,
        turn_budget_s: float = 300.0,
        cancel_poll_interval_s: float = 1.0,
    ) -> None:
        self._turn_store = turn_store
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancels: dict[str, asyncio.Event] = {}
        self._max_in_flight = max_in_flight
        self._turn_budget_s = turn_budget_s
        self._cancel_poll_interval_s = cancel_poll_interval_s

    def in_flight(self) -> int:
        return len(self._tasks)

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
        disconnect / background) — only `cancel()` stops it early.

        Raises `TurnCapacityExceeded` when this replica is already at its
        ceiling. Nothing has been spawned at that point, so the caller can
        still refund the charge and release the idempotency key."""
        if self._max_in_flight > 0 and len(self._tasks) >= self._max_in_flight:
            log.warning(
                "turn_capacity_exceeded",
                in_flight=len(self._tasks),
                max_in_flight=self._max_in_flight,
            )
            raise TurnCapacityExceeded(
                f"{len(self._tasks)} turns in flight (max {self._max_in_flight})"
            )
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        cancel_event = asyncio.Event()
        self._cancels[trace_id] = cancel_event

        async def cancel_requested() -> bool:
            """Authoritative read: in-process event, else the cross-replica
            flag. Unthrottled — used for the once-per-turn accounting decision
            below, which must never mistake a Stop for a completion."""
            if cancel_event.is_set():
                return True
            return await self._turn_store.is_cancelled(trace_id)

        # Last time the cross-replica flag was read on the streaming path.
        # 0.0 makes the first call poll, so a Stop issued before the stream
        # opened is still seen immediately.
        last_remote_poll = 0.0

        async def is_cancelled() -> bool:
            # Handed to the turn, which polls it after every streamed event.
            # Explicit cancel only — NOT socket disconnect. The in-process
            # event is checked every call; the cross-replica flag is
            # rate-limited (see `cancel_poll_interval_s`).
            nonlocal last_remote_poll
            if cancel_event.is_set():
                return True
            now = monotonic()
            if now - last_remote_poll < self._cancel_poll_interval_s:
                return False
            last_remote_poll = now
            return await self._turn_store.is_cancelled(trace_id)

        async def produce() -> None:
            # `error` frame drives refund + idempotency release. `completed`
            # is set only after the stream drains normally, so a CancelledError
            # (shutdown / explicit Stop) persists as `cancelled`, never a
            # truncated `done`.
            had_error = False
            completed = False
            cancelled = False
            # Whether any user-visible answer content has reached the client.
            # Only `delta` frames carry the answer prose; router/status/thinking
            # /tool events do NOT count. Once True, an explicit Stop must keep
            # the charge — the user already received (most of) the answer, so a
            # refund + key release would let them stream the full answer and
            # then cancel one frame before `done` for an unlimited free turn.
            answer_started = False
            buffer: list[dict[str, Any]] = []
            await self._turn_store.mark_running(trace_id, user_id)
            # Periodic liveness heartbeat — DECOUPLED from event flow. A long
            # silent generation (deep research, slow first token) used to let
            # the `running` marker TTL lapse, so a backgrounded client 404'd a
            # turn that was still alive. Drive it from a background task on a
            # fixed interval so the marker is refreshed even during total
            # output silence; cancelled in `finally` so it can't leak.
            async def _heartbeat_loop() -> None:
                try:
                    while True:
                        await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
                        await self._turn_store.heartbeat(trace_id)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 — heartbeat must never kill the turn
                    log.warning("chat_turn_heartbeat_failed", trace_id=trace_id)

            heartbeat_task = asyncio.create_task(_heartbeat_loop())
            async def _consume() -> None:
                nonlocal had_error, answer_started
                stream = stream_factory(is_cancelled)
                async for ev in stream:
                    if ev.type == "error":
                        had_error = True
                    elif ev.type == "delta":
                        answer_started = True
                    frame = {
                        "event": ev.type,
                        "data": json.dumps(ev.data, ensure_ascii=False),
                    }
                    buffer.append(frame)
                    await queue.put(frame)

            try:
                # Hard wall-clock budget. A detached turn is not bounded by the
                # client socket, so without this the ReAct ceiling times the LLM
                # timeout (~21 min) is what an abandoned turn can bill.
                if self._turn_budget_s > 0:
                    await asyncio.wait_for(_consume(), timeout=self._turn_budget_s)
                else:
                    await _consume()
                # Explicit Stop is CO-OPERATIVE: DELETE /chat/turn sets the
                # cancel flag and the turn loop (run_chat_turn) notices it and
                # `return`s — which ends this stream cleanly, looking exactly
                # like a normal completion. Without this check finalize would
                # treat a user-stopped turn as a delivered answer (no refund,
                # state="done"). Re-read the cancel signal once the stream
                # drains: if Stop was requested, account for it as cancelled
                # (`completed=False`); finalize() then refunds + releases the
                # key ONLY if no answer content was delivered yet
                # (`answer_started`). A Stop after the answer started keeps the
                # charge — see finalize.
                # Unthrottled on purpose: this runs once per turn and decides
                # refund + recorded state. The throttled streaming predicate
                # can legitimately answer "not yet" inside its window, which
                # here would misfile a Stop as a delivered answer.
                cancelled = await cancel_requested()
                completed = not cancelled
            except asyncio.CancelledError:
                # Shutdown (redeploy) OR explicit Stop (DELETE /chat/turn)
                # cancels this task. CancelledError is a BaseException, so it
                # would otherwise skip the `except Exception` below and let
                # `finally` run finalize(completed=True semantics) — charging
                # the user for a turn that never delivered an answer AND
                # holding the idempotency key for its full TTL. Mark it
                # cancelled (`completed` stays False) so finalize refunds quota
                # + releases the key and the store records state="cancelled".
                # The teardown below is shielded so the cancellation can't
                # interrupt the accounting mid-flight; we re-raise after it
                # completes.
                cancelled = True
                raise
            except TimeoutError:
                # Budget blown. `wait_for` already cancelled the producer, so
                # nothing is still generating. Surface it to the client as an
                # error frame — it is the last thing they will receive — and
                # let the normal teardown refund and record state="error".
                had_error = True
                log.warning(
                    "chat_turn_budget_exceeded",
                    trace_id=trace_id,
                    budget_s=self._turn_budget_s,
                )
                frame = {
                    "event": "error",
                    "data": json.dumps(
                        {"code": "turn_timeout", "message": "turn took too long"},
                        ensure_ascii=False,
                    ),
                }
                buffer.append(frame)
                await queue.put(frame)
            except Exception:
                had_error = True
                log.exception("chat_turn_producer_failed", trace_id=trace_id)
            finally:
                heartbeat_task.cancel()
                # Teardown does quota/idempotency accounting + buffers the turn
                # for resume. Shield it so a CancelledError (explicit Stop /
                # shutdown) can't interrupt the refund/release/finish halfway —
                # otherwise the quota stays charged and the idempotency key
                # stays held. `_teardown` swallows its own non-cancel errors so
                # it can't skip the sentinel either.
                async def _teardown() -> None:
                    # A cancelled turn is a non-clean end (`completed=False`):
                    # finalize() refunds + releases ONLY when no answer streamed
                    # (`answer_started`), while a distinct `cancelled` state lets
                    # the store/UI tell "user stopped" from "model failed". Pass
                    # the PURE error flag (cancel is conveyed by `completed`, not
                    # `had_error`) plus `answer_started` so finalize keeps the
                    # cancel path — and its post-answer charge — separate.
                    try:
                        usage_frame = await finalize(
                            had_error, completed, answer_started
                        )
                    except Exception:
                        log.exception("chat_turn_finalize_failed", trace_id=trace_id)
                        usage_frame = None
                    if usage_frame is not None:
                        buffer.append(usage_frame)
                        await queue.put(usage_frame)
                    if cancelled:
                        state = "cancelled"
                    elif had_error or not completed:
                        state = "error"
                    else:
                        state = "done"
                    await self._turn_store.finish(
                        trace_id, state=state, events=buffer, user_id=user_id,
                    )
                    # Free the admission slot BEFORE the sentinel, so capacity
                    # matches what the client can observe: releasing it after
                    # left the turn counted as in-flight for another loop
                    # iteration, and a client retrying on the sentinel could
                    # be rejected by a turn that had already finished. The
                    # turn is fully accounted by this point, so dropping it
                    # from the registry only means `shutdown()` no longer has
                    # to cancel something that is already exiting.
                    self._tasks.pop(trace_id, None)
                    self._cancels.pop(trace_id, None)
                    # Sentinel — unblocks the SSE consumer if still attached.
                    await queue.put(None)

                await asyncio.shield(asyncio.ensure_future(_teardown()))

        task = asyncio.create_task(produce())
        self._tasks[trace_id] = task
        return queue
