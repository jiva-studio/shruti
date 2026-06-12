"""Redis-backed TurnStore — buffers a chat turn's SSE events for resume.

Write-once-on-completion: while the turn runs we hold only a small
`running` marker with a short liveness TTL (refreshed by heartbeat); on
completion we overwrite it with the full event list under a 24h TTL. A
reconnecting client polls `get` and either replays the finished events or
sees `running` and waits.

Every op degrades softly (logs + no-op / None / False) — buffering is a
best-effort enhancement on top of the live SSE stream, never a
correctness dependency. AOF persistence on the Redis instance keeps the
finished blob across a restart.
"""

from __future__ import annotations

import json
from typing import Any

from redis import asyncio as redis_async
from redis.exceptions import RedisError

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

_OP_TIMEOUT_S = 0.2  # per-call hard cap; matches RedisKVCache / idempotency
_RUNNING_TTL_S = 180  # liveness window for the `running` marker; heartbeat-refreshed
_RESULT_TTL_S = 86_400  # 24h from completion — bridges "user comes back tomorrow"
_CANCEL_TTL_S = 180  # cross-replica cancel flag; same horizon as a live turn


class RedisTurnStore:
    def __init__(self, url: str) -> None:
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=_OP_TIMEOUT_S,
            socket_connect_timeout=_OP_TIMEOUT_S,
            retry_on_timeout=False,
            health_check_interval=30,
        )

    @staticmethod
    def _key(trace_id: str) -> str:
        return f"turn:{trace_id}"

    @staticmethod
    def _cancel_key(trace_id: str) -> str:
        return f"turn:{trace_id}:cancel"

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        try:
            await self._client.set(
                name=self._key(trace_id),
                value=json.dumps({"state": "running", "user_id": user_id}).encode(),
                ex=_RUNNING_TTL_S,
            )
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("turn_store_mark_running_error", err=str(exc))

    async def heartbeat(self, trace_id: str) -> None:
        try:
            await self._client.expire(self._key(trace_id), _RUNNING_TTL_S)
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("turn_store_heartbeat_error", err=str(exc))

    async def finish(
        self, trace_id: str, *, state: str, events: list[dict[str, Any]], user_id: str
    ) -> None:
        try:
            await self._client.set(
                name=self._key(trace_id),
                value=json.dumps(
                    {"state": state, "user_id": user_id, "events": events},
                    ensure_ascii=False,
                ).encode(),
                ex=_RESULT_TTL_S,
            )
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("turn_store_finish_error", err=str(exc))

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        try:
            raw = await self._client.get(self._key(trace_id))
            if raw is None:
                return None
            return json.loads(raw)
        except (RedisError, TimeoutError, OSError, ValueError) as exc:
            log.warning("turn_store_get_error", err=str(exc))
            return None

    async def request_cancel(self, trace_id: str) -> None:
        try:
            await self._client.set(self._cancel_key(trace_id), b"1", ex=_CANCEL_TTL_S)
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning("turn_store_request_cancel_error", err=str(exc))

    async def is_cancelled(self, trace_id: str) -> bool:
        try:
            return bool(await self._client.exists(self._cancel_key(trace_id)))
        except (RedisError, TimeoutError, OSError) as exc:
            # Degrade closed (don't cancel) — an infra hiccup must never
            # kill a live turn.
            log.warning("turn_store_is_cancelled_error", err=str(exc))
            return False

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass
