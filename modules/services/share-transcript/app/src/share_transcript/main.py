"""FastAPI entrypoint for share-transcript.

POST /pdf — render (or reuse a cached) transcript PDF for one track and
return its public URL. The caller sends the track's cover metadata + the
S3 key of the transcript to read; the service renders, caches to S3, and
returns `{track_id, lang, url, ready}`. The output format is the path
segment (`/pdf` today; `/txt` etc. can follow as sibling routes), reached
behind Caddy as `/share/transcripts/pdf`.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from share_transcript import config, llm
from share_transcript.meta import TrackMeta
from share_transcript.pipeline import TranscriptUnavailable, prepare_pdf
from share_transcript.render.fonts import register_fonts
from share_transcript.s3 import S3

log = logging.getLogger("share_transcript")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    settings = config.load()
    llm.configure(settings)
    # Register the bundled TTFs once so the first request doesn't pay it.
    register_fonts()
    app.state.settings = settings
    app.state.s3 = S3(settings)
    log.info("share_transcript_ready port=%s bucket=%s", settings.port, settings.s3_bucket)
    yield


app = FastAPI(title="Shruti share-transcript", lifespan=lifespan)

# Mobile talks to us cross-origin (Capacitor WebView). Mirror share-audio:
# anonymous, POST/OPTIONS only, JSON content-type.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    # Anonymous endpoint — same posture as share-audio: only Content-Type.
    allow_headers=["Content-Type"],
    max_age=600,
)


class RefIn(BaseModel):
    short_name: str | None = None
    full_name: str | None = None
    source_id: str | None = None
    tokens: str | None = None


class PdfRequest(BaseModel):
    track_id: str = Field(min_length=1)
    # Any catalog language code (the transcript's effective lang) — labels
    # fall back to EN for unknown codes; not limited to ru/en.
    lang: str = Field("ru", min_length=2, max_length=16)
    transcript_key: str = Field(min_length=1)
    # Cover metadata — all optional; the renderer degrades to id-only.
    title: str | None = None
    author_name: str | None = None
    author_id: str | None = None
    date: str | None = None
    location_name: str | None = None
    location_id: str | None = None
    references: list[RefIn] = []
    tags: list[str] = []


class PdfResponse(BaseModel):
    track_id: str
    lang: str
    url: str
    ready: bool


_BUILD = {
    "sha": os.getenv("SHRUTI_BUILD_SHA", "dev"),
    "time": os.getenv("SHRUTI_BUILD_TIME", "dev"),
}


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "build": _BUILD}


@app.post("/pdf", response_model=PdfResponse)
async def pdf(body: PdfRequest, response: Response) -> PdfResponse:
    settings: config.Settings = app.state.settings
    s3: S3 = app.state.s3

    # Defence in depth: only render transcripts that live under the
    # published-tracks prefix — never an arbitrary S3 key.
    if not body.transcript_key.startswith(settings.source_key_prefix):
        raise HTTPException(status_code=400, detail={"code": "bad_transcript_key"})

    meta = TrackMeta.from_wire(body.model_dump())
    try:
        result = await prepare_pdf(
            meta=meta,
            lang=body.lang,
            transcript_key=body.transcript_key,
            s3=s3,
            settings=settings,
        )
    except TranscriptUnavailable:
        raise HTTPException(status_code=404, detail={"code": "transcript_unavailable"})
    except Exception as exc:  # noqa: BLE001
        log.exception("pdf_dispatch_failed track=%s err=%s", body.track_id, exc)
        raise HTTPException(status_code=500, detail={"code": "render_failed"})

    # Warm hit → 200; cold render dispatched → 202 + predicted URL the
    # client polls (same contract as share-audio's /excerpts).
    if not result["ready"]:
        response.status_code = status.HTTP_202_ACCEPTED
    return PdfResponse(**result)
