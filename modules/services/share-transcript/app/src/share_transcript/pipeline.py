"""prepare_pdf — render-or-reuse one track's transcript PDF.

Client-initiated, async — same model as share-audio:

- Warm: the PDF is already in the store at the current renderer version →
  return `ready=True` + its URL.
- Cold: do the cheap checks synchronously (so "no transcript" fails fast
  with a 404), then dispatch the heavy render (transcript fetch + reportlab +
  PUT) to a background task and return immediately with `ready=False` + the
  predicted URL. The client polls that URL until the object goes live
  (`resolveShareArtifact` / `pollUntilReady`).

The PDF lives at `public/tracks/<id>/exports/<lang>.pdf`, the key the app
predicts. The store keeps no custom metadata, so the renderer version that
produced it is a sidecar object `<pdf key>.version`, written after the PDF;
a missing or older marker is a cache miss and the PDF is rendered again in
place.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from share_transcript.keys import pdf_key
from share_transcript.meta import TrackMeta
from share_transcript.ports import ObjectStore
from share_transcript.render import render_transcript_pdf

log = logging.getLogger("share_transcript.pipeline")

# Bump in lockstep with the renderer's layout: a cached PDF tagged with an
# older version is treated as a cache miss and re-rendered in place.
PDF_RENDER_VERSION = "v4"


class TranscriptUnavailable(Exception):
    """The transcript object named by `transcript_key` is missing."""


# Coalesce concurrent renders of the same output key — a second tap while
# the first render is in flight reuses the running task instead of paying
# for a duplicate reportlab pass. Best-effort, process-local (one uvicorn
# worker); a cross-worker dup just overwrites the same idempotent key.
_inflight: dict[str, asyncio.Task[None]] = {}

# PDFs this process rendered and stored whose version marker write failed.
# The next request for the key retries only the marker, so a flaky marker
# write costs one render, not one per request.
_marker_owed: set[str] = set()


def _version_key(key: str) -> str:
    return key + ".version"


async def _is_current(store: ObjectStore, key: str) -> bool:
    marker = await store.get_text(_version_key(key))
    return marker is not None and marker.strip() == PDF_RENDER_VERSION


async def _render_and_store(
    meta: TrackMeta,
    lang: str,
    transcript_key: str,
    outline: dict[str, Any] | None,
    store: ObjectStore,
) -> None:
    """Background leg: fetch transcript, render with the supplied outline,
    upload the PDF, then its version marker.

    Best-effort — a failure is logged and the object simply never appears,
    so the client's poll times out and surfaces a retryable error. Runs
    detached from the request, so a client disconnect doesn't kill it.
    """
    key = pdf_key(meta.id, lang)
    try:
        transcript = await store.get_json(transcript_key)
        pdf_bytes = await asyncio.to_thread(
            render_transcript_pdf,
            track=meta,
            transcript=transcript,
            outline=outline,
            lang=lang,
        )
        await store.put(key, pdf_bytes, "application/pdf")
    except Exception:  # noqa: BLE001 — background task must not raise
        log.exception("render_failed track=%s lang=%s", meta.id, lang)
        return
    _marker_owed.add(key)
    await _write_marker(store, key)
    log.info("render_done track=%s lang=%s", meta.id, lang)


async def _write_marker(store: ObjectStore, key: str) -> bool:
    try:
        await store.put(_version_key(key), PDF_RENDER_VERSION.encode(), "text/plain")
    except Exception:  # noqa: BLE001 — retried on the next request for the key
        log.exception("marker_write_failed key=%s", key)
        return False
    _marker_owed.discard(key)
    return True


async def prepare_pdf(
    *,
    meta: TrackMeta,
    lang: str,
    transcript_key: str,
    outline: dict[str, Any] | None = None,
    store: ObjectStore,
    public_url: Callable[[str], str],
) -> dict[str, Any]:
    key = pdf_key(meta.id, lang)
    url = public_url(key)

    if await _is_current(store, key):
        return {"track_id": meta.id, "lang": lang, "url": url, "ready": True}

    if key in _marker_owed and key not in _inflight:
        ready = await _write_marker(store, key)
        return {"track_id": meta.id, "lang": lang, "url": url, "ready": ready}

    # Cheap synchronous gate: a missing transcript is the common case and
    # must fail fast as a 404, not as a poll timeout.
    if not await store.exists(transcript_key):
        raise TranscriptUnavailable(transcript_key)

    # Cold: dispatch the heavy render in the background (coalesced by the
    # output key) and answer immediately with the predicted URL.
    if key not in _inflight:
        task = asyncio.create_task(_render_and_store(meta, lang, transcript_key, outline, store))
        _inflight[key] = task
        task.add_done_callback(lambda _t, k=key: _inflight.pop(k, None))

    return {"track_id": meta.id, "lang": lang, "url": url, "ready": False}
