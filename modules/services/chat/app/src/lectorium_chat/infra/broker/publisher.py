"""`IngestRequestPublisher` port + Redis Streams / no-op implementations.

When a PRO user adds an external lecture, chat publishes one message to the
`ingest.request` stream so the ingest worker (#1224) can fetch + transcribe
+ index it. The body travels in a single `payload` stream field as JSON
`{url, token, user_id, title}` — the shared Redis-Streams envelope convention
every Lectorium service uses (the orchestrator decodes it into its `Request`,
whose fields are `url` / `token` / `user_id` / `title`). `token` carries the
caller's JWT; the orchestrator re-verifies the PRO tier and does the heavy
lifting. `title` is the source title chat already resolved, so a track is
never announced untitled.

Every publish is best-effort: an absent/unreachable broker logs and returns
False rather than raising, because a chat turn must not fail just because
the ingest pipeline is down. That also means the feature works before #1224
lands (the message simply queues, or no-ops when unconfigured).
"""

from __future__ import annotations

import json
from typing import Protocol

from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

_OP_TIMEOUT_S = 0.5  # a publish must never stall the SSE turn
# XADD MAXLEN cap — bound the stream so an unconsumed backlog (ingest worker
# down) can't grow without limit. Approximate trim (~) is cheap.
_STREAM_MAXLEN = 100_000


class IngestRequestPublisher(Protocol):
    async def publish(
        self, *, user_id: str, url: str, jwt: str, title: str = ""
    ) -> bool:
        """Publish one ingest request. Returns True on a confirmed enqueue,
        False on any soft failure (never raises)."""
        ...


class NoopIngestPublisher:
    """Used when no broker URL is configured. Logs the intent so the add is
    still observable, and reports False (nothing was actually enqueued)."""

    async def publish(
        self, *, user_id: str, url: str, jwt: str, title: str = ""
    ) -> bool:
        log.info("ingest_publish_noop", user_id=user_id, url=url)
        return False


class RedisStreamsIngestPublisher:
    """XADD onto a Redis Stream. Own client (may point at a DIFFERENT Redis
    than the cache/rate-limit store — `STREAMS_REDIS_URL`)."""

    def __init__(self, url: str, *, stream: str = "ingest.request") -> None:
        from redis import asyncio as redis_async

        self._stream = stream
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            socket_timeout=_OP_TIMEOUT_S,
            socket_connect_timeout=_OP_TIMEOUT_S,
            retry_on_timeout=False,
            health_check_interval=30,
        )

    async def publish(
        self, *, user_id: str, url: str, jwt: str, title: str = ""
    ) -> bool:
        from redis.exceptions import RedisError

        # Single `payload` field carrying the JSON body — the shared envelope
        # the orchestrator's consumer unwraps. Keys match its `Request` struct
        # (`url` / `token` / `user_id` / `title`); the JWT goes in `token`.
        body = {"url": url, "token": jwt, "user_id": user_id, "title": title}
        fields = {b"payload": json.dumps(body).encode()}
        try:
            msg_id = await self._client.xadd(
                self._stream, fields, maxlen=_STREAM_MAXLEN, approximate=True
            )
        except (RedisError, TimeoutError, OSError) as exc:
            log.warning(
                "ingest_publish_failed",
                stream=self._stream,
                user_id=user_id,
                error=str(exc),
            )
            return False
        log.info(
            "ingest_published",
            stream=self._stream,
            user_id=user_id,
            url=url,
            msg_id=msg_id.decode() if isinstance(msg_id, bytes) else str(msg_id),
        )
        return True

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:  # pragma: no cover — teardown best-effort
            pass


def build_ingest_publisher(
    url: str | None, *, stream: str = "ingest.request"
) -> IngestRequestPublisher:
    """Redis Streams publisher when a URL is configured, else the no-op."""
    if url:
        return RedisStreamsIngestPublisher(url, stream=stream)
    return NoopIngestPublisher()
