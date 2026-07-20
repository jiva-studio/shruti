"""`track.published` consumer — graft a promoted user track into the corpus.

Background Redis-Streams consumer (started from `main.py` lifespan) that reacts
to the publish-service's promotion event (#1236). When a user-uploaded track is
approved and published into the corpus, publish-service emits `track.published`;
this consumer runs `indexer.run._graft_promoted_track`, which relabels that
track's already-indexed `user_track` chunks onto the public `track_transcript`
lane and drops the `owned` ACL rows — no re-embedding required.

Design contract mirrors the sibling `track.events` consumer:
  - Idempotent by track_id: the graft is an ON-CONFLICT-free UPDATE/DELETE that
    matches nothing once already grafted, so a redelivery is a cheap no-op.
  - Best-effort & non-fatal: a malformed message is logged and ACKed (so it
    doesn't wedge the group); a transient DB failure is NOT ACKed so it is
    re-delivered. The consumer never raises out of its loop.
  - No-op when STREAMS_REDIS_URL is unset — `build_track_published_consumer`
    returns None and the lifespan simply doesn't start the task.
  - The indexer-time (re)index of the public transcript stays the safety net.

Event shape: the publish-service relay ships the JSON body in a single `payload`
stream field ({"type","track_id","owner_id","user_id"}). For robustness this
consumer also accepts flat stream fields (a bare `track_id`), matching how the
`track.events` consumer reads its messages.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.indexer.run import _graft_promoted_track
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

_BLOCK_MS = 5000  # XREADGROUP block window; bounds shutdown latency
_BATCH = 16
# Reclaim PEL entries idle this long — a graft that raised (un-ACKed) or a
# crashed consumer's in-flight message. The read loop only fetches new ('>')
# entries, so without XAUTOCLAIM a non-ACKed message is never retried. Must exceed
# the slowest in-flight graft so a live entry isn't reclaimed out from under a slow
# replica sharing this consumer name; 15 min matches the Go services.
_RECLAIM_MIN_IDLE_MS = 900_000  # 15 min — parity with the Go services


def _decode(v: Any) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else str(v)


def _extract_track_id(fields: dict[str, str]) -> str:
    """Pull track_id from either the JSON `payload` envelope or flat fields."""
    raw = fields.get("payload")
    if raw:
        try:
            body = json.loads(raw)
            if isinstance(body, dict) and body.get("track_id"):
                return str(body["track_id"])
        except json.JSONDecodeError:
            pass
    return fields.get("track_id") or ""


class TrackPublishedConsumer:
    def __init__(
        self,
        url: str,
        *,
        stream: str,
        group: str,
        consumer: str,
        settings: Settings,
    ) -> None:
        from redis import asyncio as redis_async

        self._stream = stream
        self._group = group
        self._consumer = consumer
        self._settings = settings
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            health_check_interval=30,
        )

    async def ensure_group(self) -> None:
        """Create the consumer group (and the stream via MKSTREAM) if absent."""
        from redis.exceptions import ResponseError

        try:
            await self._client.xgroup_create(
                self._stream, self._group, id="0", mkstream=True
            )
        except ResponseError as exc:
            # BUSYGROUP: the group already exists — expected on every restart.
            if "BUSYGROUP" not in str(exc):
                raise

    async def run(self, stop_event: asyncio.Event) -> None:
        """Read → dispatch → ACK loop until `stop_event` is set."""
        try:
            await self.ensure_group()
        except Exception as exc:  # noqa: BLE001 — a broker blip must not crash boot
            log.error("track_published_group_create_failed", error=str(exc))
            return
        log.info(
            "track_published_consumer_started", stream=self._stream, group=self._group
        )
        while not stop_event.is_set():
            await self._reclaim()
            try:
                resp = await self._client.xreadgroup(
                    self._group,
                    self._consumer,
                    {self._stream: ">"},
                    count=_BATCH,
                    block=_BLOCK_MS,
                )
            except Exception as exc:  # noqa: BLE001 — transient read error → retry
                log.warning("track_published_read_failed", error=str(exc))
                await asyncio.sleep(1.0)
                continue
            if not resp:
                continue
            for _stream, entries in resp:
                for msg_id, fields in entries:
                    await self._process(msg_id, fields)
        log.info("track_published_consumer_stopped", stream=self._stream)

    async def _reclaim(self) -> None:
        """Redeliver PEL entries idle > _RECLAIM_MIN_IDLE_MS back to this consumer,
        so a graft that failed transiently (un-ACKed) is retried rather than
        stranded. Best-effort: a reclaim error is logged and skipped."""
        try:
            resp = await self._client.xautoclaim(
                self._stream,
                self._group,
                self._consumer,
                _RECLAIM_MIN_IDLE_MS,
                start_id="0-0",
                count=_BATCH,
            )
        except Exception as exc:  # noqa: BLE001 — reclaim is best-effort
            log.warning("track_published_reclaim_failed", error=str(exc))
            return
        # redis-py returns [next_cursor, messages] (Redis 6.2) or
        # [next_cursor, messages, deleted_ids] (Redis 7+); only messages matter.
        messages = resp[1] if isinstance(resp, (list, tuple)) and len(resp) > 1 else []
        for msg_id, fields in messages:
            await self._process(msg_id, fields)

    async def _process(self, msg_id: Any, raw_fields: Any) -> None:
        fields = {_decode(k): _decode(v) for k, v in (raw_fields or {}).items()}
        try:
            acked = await self.handle(fields)
        except Exception as exc:  # noqa: BLE001 — do NOT ack: allow redelivery
            log.warning(
                "track_published_handle_failed",
                error=str(exc),
                track_id=_extract_track_id(fields),
            )
            return
        if acked:
            try:
                await self._client.xack(self._stream, self._group, msg_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("track_published_ack_failed", error=str(exc))

    async def handle(self, fields: dict[str, str]) -> bool:
        """Graft one promoted track. Returns True when the message should be
        ACKed (handled, or permanently unprocessable), False to force redelivery.

        Split out from the Redis loop so tests drive it with a plain dict."""
        track_id = _extract_track_id(fields)
        if not track_id:
            log.warning("track_published_missing_track_id")
            return True  # unprocessable — ack to drop
        await _graft_promoted_track(track_id, settings=self._settings)
        return True

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:  # pragma: no cover — teardown best-effort
            pass


def build_track_published_consumer(
    settings: Settings | None = None,
) -> TrackPublishedConsumer | None:
    """Consumer when STREAMS_REDIS_URL is set, else None (feature off)."""
    s = settings or get_settings()
    if not s.streams_redis_url:
        return None
    return TrackPublishedConsumer(
        s.streams_redis_url,
        stream=s.track_published_stream,
        group=s.track_published_group,
        consumer=s.track_published_consumer,
        settings=s,
    )
