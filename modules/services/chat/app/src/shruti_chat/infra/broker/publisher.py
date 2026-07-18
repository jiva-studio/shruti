"""`IngestRequestPublisher` port + Redis Streams / no-op implementations.

When a PRO user adds an external lecture, chat publishes one message to the
`ingest.request` stream so the ingest worker (#1224) can fetch + transcribe
+ index it. Payload is intentionally tiny — `{user_id, url, jwt}` — the
worker re-verifies the JWT and does the heavy lifting.

Every publish is best-effort: an absent/unreachable broker logs and returns
False rather than raising, because a chat turn must not fail just because
the ingest pipeline is down. That also means the feature works before #1224
lands (the message simply queues, or no-ops when unconfigured).
"""

from __future__ import annotations

from typing import Protocol

from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_OP_TIMEOUT_S = 0.5  # a publish must never stall the SSE turn
# XADD MAXLEN cap — bound the stream so an unconsumed backlog (ingest worker
# down) can't grow without limit. Approximate trim (~) is cheap.
_STREAM_MAXLEN = 100_000


class IngestRequestPublisher(Protocol):
    async def publish(self, *, user_id: str, url: str, jwt: str) -> bool:
        """Publish one ingest request. Returns True on a confirmed enqueue,
        False on any soft failure (never raises)."""
        ...


class NoopIngestPublisher:
    """Used when no broker URL is configured. Logs the intent so the add is
    still observable, and reports False (nothing was actually enqueued)."""

    async def publish(self, *, user_id: str, url: str, jwt: str) -> bool:
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

    async def publish(self, *, user_id: str, url: str, jwt: str) -> bool:
        from redis.exceptions import RedisError

        fields = {
            b"user_id": user_id.encode(),
            b"url": url.encode(),
            b"jwt": jwt.encode(),
        }
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
