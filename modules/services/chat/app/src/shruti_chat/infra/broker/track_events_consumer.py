"""`track.events` consumer — private per-user RAG indexing + ACL projection.

Background Redis-Streams consumer (started from `main.py` lifespan) that turns
track-lifecycle events into two side effects for the private lane (#1227):

  - `track.ready`   → index the transcript under `kind='user_track'` AND upsert
                      the `owned(user_id, track_id)` ACL row. The event's
                      `author_raw` is resolved to a catalog author and stamped on
                      the chunks, which is what lets a lecturer filter reach
                      someone's own uploads.
  - `library.unlinked` → delete the `owned` row (revoke this user's access).
                      (Consumer wired; a producer for this removal event is not
                      yet implemented — see the personal-library architecture doc.)

Design contract:
  - Idempotent by track_id: re-delivery of the same `track.ready` re-runs the
    DB upserts (which are ON CONFLICT / delete-reinsert and therefore safe) but
    skips the expensive re-embed via a Redis processed-set guard.
  - Best-effort & non-fatal: a malformed message is logged and ACKed (so it
    doesn't wedge the group); a transient failure is NOT ACKed so it is
    re-delivered. The consumer never raises out of its loop.
  - No-op when STREAMS_REDIS_URL is unset — `build_track_events_consumer`
    returns None and the lifespan simply doesn't start the task.

Wire format: the orchestrator's relay ships the event as a single `payload`
stream field carrying JSON `{id, type, user_id, doc_id, track_id, data}`, where
`data` is the library_items projection `{status, track_id, lang, title_raw,
audio_key, transcript_key, source_url}`. `_unwrap_payload` flattens that into a
string dict so the handler can read `type`, `track_id`, `user_id`, `lang`, and
`transcript_key` uniformly. A legacy flat-field message (no `payload`) passes
through unchanged. The transcript is not inline: a `track.ready` carries a
`transcript_key` blob path that `_maybe_index` resolves to the CDN and fetches.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from shruti_chat.config import Settings, get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer.embed import Embedder, get_embedder
from shruti_chat.application.author_lookup import resolve_author
from shruti_chat.indexer.run import index_one_track
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_BLOCK_MS = 5000  # XREADGROUP block window; bounds shutdown latency
_BATCH = 16
# The socket read deadline MUST exceed the block window. redis-py's
# DEFAULT_SOCKET_TIMEOUT is 5s, exactly equal to _BLOCK_MS — so the client-side
# read times out at the same instant the server returns its empty blocking reply,
# raising a spurious `Timeout reading from redis-streams` on every idle cycle
# (the read still works when a message arrives, so the group never lags — it's
# pure log noise + a wasted retry). Give the socket a few seconds of headroom
# past the block so the empty reply always arrives first.
_SOCKET_TIMEOUT_S = _BLOCK_MS / 1000 + 3
# Processed-track guard TTL — a track re-delivered within this window skips the
# re-embed. Long enough to absorb consumer restarts / redeliveries, short
# enough that a genuinely re-uploaded (re-transcribed) track re-indexes.
_PROCESSED_TTL_S = 7 * 24 * 3600
# Reclaim entries stranded in the group PEL (a delivery that was never ACKed —
# handler error — or a crashed consumer's in-flight message) once they have sat
# idle this long. The read loop only fetches new ('>') entries, so without an
# explicit XAUTOCLAIM a non-ACKed message is NEVER re-read — the transient-failure
# retry the design contract promises would silently never happen. This MUST exceed
# the slowest in-flight handle (a large transcript's embed) so a live-but-slow
# message on one replica isn't reclaimed — and ACKed via the processed-set guard —
# out from under it by another replica sharing this consumer name, which would drop
# the index entirely. 15 min matches the Go consumers (ingest/orchestrator/profile),
# which set the same window for the same reason.
_RECLAIM_MIN_IDLE_MS = 900_000  # 15 min — parity with the Go services


def _decode(v: Any) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else str(v)





def _unwrap_payload(fields: dict[str, str]) -> dict[str, str]:
    """Flatten the orchestrator's `payload` JSON envelope into the string dict
    the handler reads.

    The relay ships `{id, type, user_id, doc_id, track_id, data:{...}}` in a
    single `payload` field. We lift both the top-level keys (type, track_id,
    user_id, doc_id) and the nested `data` projection (lang, transcript_key,
    title_raw, …) into one flat dict. A message with no `payload` (legacy flat
    fields) or a malformed one is returned unchanged so nothing is lost.
    """
    raw = fields.get("payload")
    if not raw:
        return fields
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fields
    if not isinstance(body, dict):
        return fields

    def _stringify(v: Any) -> str:
        if isinstance(v, str):
            return v
        if isinstance(v, (dict, list)):
            return json.dumps(v)
        return str(v)

    flat: dict[str, str] = {}
    data = body.get("data")
    if isinstance(data, dict):
        flat.update({k: _stringify(v) for k, v in data.items() if v is not None})
    # Top-level keys win over `data` on any overlap (e.g. track_id is identical).
    flat.update(
        {k: _stringify(v) for k, v in body.items() if k != "data" and v is not None}
    )
    return flat


async def upsert_owned(user_id: str, track_id: str) -> None:
    """Assert `user_id` owns `track_id` (idempotent)."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """
            INSERT INTO owned (user_id, track_id) VALUES ($1, $2)
            ON CONFLICT (user_id, track_id) DO NOTHING
            """,
            user_id, track_id,
        )


async def delete_owned(user_id: str, track_id: str) -> None:
    """Revoke `user_id`'s access to `track_id` (idempotent)."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            "DELETE FROM owned WHERE user_id = $1 AND track_id = $2",
            user_id, track_id,
        )



class TrackEventsConsumer:
    def __init__(
        self,
        url: str,
        *,
        stream: str,
        group: str,
        consumer: str,
        settings: Settings,
        embedder: Embedder,
        catalog_repo: Any | None = None,
    ) -> None:
        from redis import asyncio as redis_async

        self._stream = stream
        self._group = group
        self._consumer = consumer
        self._settings = settings
        self._embedder = embedder
        # Resolves the ingest's speaker name to a catalog author, once per
        # indexed track. None (test harnesses, catalog-less runs) simply leaves
        # the chunks unattributed.
        self._catalog_repo = catalog_repo
        self._processed_set = f"chat:track_events:indexed:{settings.embed_model}"
        self._client = redis_async.from_url(
            url,
            decode_responses=False,
            health_check_interval=30,
            socket_timeout=_SOCKET_TIMEOUT_S,
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
            log.error("track_events_group_create_failed", error=str(exc))
            return
        log.info("track_events_consumer_started", stream=self._stream, group=self._group)
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
                log.warning("track_events_read_failed", error=str(exc))
                await asyncio.sleep(1.0)
                continue
            if not resp:
                continue
            for _stream, entries in resp:
                for msg_id, fields in entries:
                    await self._process(msg_id, fields)
        log.info("track_events_consumer_stopped", stream=self._stream)

    async def _reclaim(self) -> None:
        """Redeliver PEL entries idle > _RECLAIM_MIN_IDLE_MS back to this consumer.

        Closes the gap where a handler error leaves a message un-ACKed but the
        read loop (fetching only '>') never re-reads it — so the transient-failure
        retry the class docstring promises actually happens. Best-effort: a
        reclaim error is logged and the loop proceeds to a normal read."""
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
            log.warning("track_events_reclaim_failed", error=str(exc))
            return
        # redis-py returns [next_cursor, messages] (Redis 6.2) or
        # [next_cursor, messages, deleted_ids] (Redis 7+); only messages matter.
        messages = resp[1] if isinstance(resp, (list, tuple)) and len(resp) > 1 else []
        for msg_id, fields in messages:
            await self._process(msg_id, fields)

    async def _process(self, msg_id: Any, raw_fields: Any) -> None:
        fields = {_decode(k): _decode(v) for k, v in (raw_fields or {}).items()}
        fields = _unwrap_payload(fields)
        try:
            acked = await self.handle(fields)
        except Exception as exc:  # noqa: BLE001 — do NOT ack: allow redelivery
            log.warning(
                "track_event_handle_failed",
                error=str(exc),
                type=fields.get("type") or fields.get("event"),
                track_id=fields.get("track_id"),
            )
            return
        # ACK on success OR on a permanently-unprocessable message (acked=True):
        # leaving a poison message un-ACKed would wedge the group forever.
        if acked:
            try:
                await self._client.xack(self._stream, self._group, msg_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("track_event_ack_failed", error=str(exc))

    async def handle(self, fields: dict[str, str]) -> bool:
        """Apply one event. Returns True when the message should be ACKed
        (handled, or permanently unprocessable), False to force redelivery.

        Split out from the Redis loop so tests drive it directly with a plain
        dict — no fake stream plumbing required."""
        etype = fields.get("type") or fields.get("event") or ""
        track_id = fields.get("track_id") or ""
        user_id = fields.get("user_id") or ""

        if not track_id:
            log.warning("track_event_missing_track_id", type=etype)
            return True  # unprocessable — ack to drop

        if etype == "library.unlinked":
            if user_id:
                await delete_owned(user_id, track_id)
            return True

        if etype == "track.ready":
            # ACL first — cheap, idempotent, and independent of indexing so
            # ownership is asserted even if the transcript indexing is deferred.
            if user_id:
                await upsert_owned(user_id, track_id)
            await self._maybe_index(track_id, fields)
            return True

        log.info("track_event_ignored", type=etype, track_id=track_id)
        return True

    async def _resolve_speaker(self, author_raw: str | None) -> str | None:
        """The catalog author the ingest's speaker name denotes, or None.

        Resolved ONCE here rather than on every turn: the answer only changes
        when the dictionary does, and a re-ingest re-runs it. None — unknown
        speaker, or one the corpus has never heard of — is a normal outcome; the
        chunks simply carry no author, and a lecturer filter then passes them
        over.
        """
        name = (author_raw or "").strip()
        if not name or self._catalog_repo is None:
            return None
        hit = await resolve_author(self._catalog_repo, name)
        log.info(
            "user_track_speaker_resolved",
            author_raw=name, author_id=hit.id if hit else None,
        )
        return hit.id if hit is not None else None

    async def _maybe_index(self, track_id: str, fields: dict[str, str]) -> None:
        """Index the track's transcript under kind='user_track', idempotent by
        track_id via a Redis processed-set (skips the re-embed on redelivery).

        No transcript reference on the event ⇒ nothing to index (the ACL was
        still set); logged, not an error."""
        transcript_ref: dict | str | None = None
        raw = fields.get("transcript")
        if raw:
            try:
                transcript_ref = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("track_event_bad_transcript_json", track_id=track_id)
        if transcript_ref is None:
            url = fields.get("transcript_url") or fields.get("transcript_key")
            if url:
                transcript_ref = url
        if transcript_ref is None:
            log.info("track_ready_no_transcript_ref", track_id=track_id)
            return

        lang = fields.get("lang") or fields.get("language") or "en"

        # Idempotency guard: SADD returns 1 only for a first-seen track_id.
        try:
            added = await self._client.sadd(self._processed_set, track_id.encode())
            if added:
                await self._client.expire(self._processed_set, _PROCESSED_TTL_S)
        except Exception:  # noqa: BLE001 — guard is best-effort; fall through
            added = 1
        if not added:
            log.info("track_ready_already_indexed", track_id=track_id)
            return

        try:
            n = await index_one_track(
                track_id,
                transcript_ref,
                lang,
                kind="user_track",
                embedder=self._embedder,
                settings=self._settings,
                author_id=await self._resolve_speaker(fields.get("author_raw")),
            )
            log.info("user_track_indexed", track_id=track_id, chunks=n)
        except Exception:
            # Re-embed failed — release the guard so a redelivery retries, and
            # re-raise so the message is NOT ACKed.
            try:
                await self._client.srem(self._processed_set, track_id.encode())
            except Exception:  # noqa: BLE001
                pass
            raise

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:  # pragma: no cover — teardown best-effort
            pass


def build_track_events_consumer(
    settings: Settings | None = None,
    embedder: Embedder | None = None,
    catalog_repo: Any | None = None,
) -> TrackEventsConsumer | None:
    """Consumer when STREAMS_REDIS_URL is set, else None (feature off)."""
    s = settings or get_settings()
    if not s.streams_redis_url:
        return None
    return TrackEventsConsumer(
        s.streams_redis_url,
        stream=s.track_events_stream,
        group=s.track_events_group,
        consumer=s.track_events_consumer,
        settings=s,
        embedder=embedder or get_embedder(s),
        catalog_repo=catalog_repo,
    )
