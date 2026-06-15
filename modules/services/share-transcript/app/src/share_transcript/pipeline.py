"""prepare_pdf — render-or-reuse one track's transcript PDF.

Client-initiated, async — same model as share-audio:

- Warm: the PDF is already on the CDN → return `ready=True` + its URL.
- Cold: do the cheap checks synchronously (so "no transcript" fails fast
  with a 404), then dispatch the heavy render (transcript fetch + outline
  LLM + reportlab + S3 PUT) to a background task and return immediately
  with `ready=False` + the predicted URL. The client polls that URL until
  the object goes live (`resolveShareArtifact` / `pollUntilReady`).

The predicted URL is the canonical key, so it equals the URL the render
writes to — the client's poll and the eventual object are the same.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from share_transcript.config import Settings
from share_transcript.meta import TrackMeta
from share_transcript.render import render_transcript_pdf
from share_transcript.s3 import S3

log = logging.getLogger("share_transcript.pipeline")


class TranscriptUnavailable(Exception):
    """The transcript object named by `transcript_key` is missing."""


# Coalesce concurrent renders of the same output key — a second tap while
# the first render is in flight reuses the running task instead of paying
# for a duplicate reportlab pass. Best-effort, process-local (one uvicorn
# worker); a cross-worker dup just overwrites the same idempotent key.
_inflight: dict[str, asyncio.Task[None]] = {}


# Filesystem-unsafe characters Windows / macOS reject in share targets;
# Cyrillic + IAST diacritics pass through untouched.
_BAD_FNAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _share_filename(meta: TrackMeta, lang: str) -> str:
    base = (meta.title or "").strip() or meta.id
    safe = _BAD_FNAME.sub("", base)
    safe = re.sub(r"\s+", " ", safe).strip()[:80] or meta.id
    if meta.date:
        safe = f"{safe} ({meta.date})"
    return f"{safe}.pdf"


async def _render_and_store(
    meta: TrackMeta,
    lang: str,
    transcript_key: str,
    outline: dict[str, Any] | None,
    s3: S3,
    settings: Settings,
) -> None:
    """Background leg: fetch transcript, render with the supplied outline,
    upload.

    Best-effort — a failure is logged and the object simply never appears,
    so the client's poll times out and surfaces a retryable error. Runs
    detached from the request, so a client disconnect doesn't kill it.
    """
    try:
        transcript = await s3.get_json(transcript_key)
        pdf_bytes = await asyncio.to_thread(
            render_transcript_pdf,
            track=meta,
            transcript=transcript,
            outline=outline,
            lang=lang,
        )
        await s3.put_pdf(meta.id, lang, pdf_bytes, _share_filename(meta, lang))
    except Exception:  # noqa: BLE001 — background task must not raise
        log.exception("render_failed track=%s lang=%s", meta.id, lang)


async def prepare_pdf(
    *,
    meta: TrackMeta,
    lang: str,
    transcript_key: str,
    outline: dict[str, Any] | None = None,
    s3: S3,
    settings: Settings,
) -> dict[str, Any]:
    url = s3.public_url(S3.pdf_key(meta.id, lang))

    # Warm: already on the CDN.
    if await s3.pdf_exists(meta.id, lang):
        return {"track_id": meta.id, "lang": lang, "url": url, "ready": True}

    # Cheap synchronous gate: a missing transcript is the common case
    # (RU tracks) and must fail fast as a 404, not as a poll timeout.
    if not await s3.object_exists(transcript_key):
        raise TranscriptUnavailable(transcript_key)

    # Cold: dispatch the heavy render in the background (coalesced by the
    # output key) and answer immediately with the predicted URL.
    pdf_key = S3.pdf_key(meta.id, lang)
    if pdf_key not in _inflight:
        task = asyncio.create_task(
            _render_and_store(meta, lang, transcript_key, outline, s3, settings)
        )
        _inflight[pdf_key] = task
        task.add_done_callback(lambda _t, k=pdf_key: _inflight.pop(k, None))

    return {"track_id": meta.id, "lang": lang, "url": url, "ready": False}
