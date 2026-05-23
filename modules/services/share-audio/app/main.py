"""FastAPI entrypoint for share-audio.

Wraps the existing handler.py / storage.py / event_adapter.py modules so
the same cut-and-upload pipeline that ran inside AWS Lambda / YC Function
now runs in a long-lived container. The HTTP contract is identical to
what the mobile clients already speak:

  POST /excerpts
  {
    "source_key": "public/tracks/.../audio/foo.mp3",
    "start_ms":   12345,
    "end_ms":     45678,
    "excerpt_id": "<optional stable id>"
  }
  → 200 {"excerpt_id": "...", "url": "https://...mp3", "ready": true}

CORS allows `*` to match the prior Lambda behaviour (mobile-Capacitor
runs from `capacitor://localhost` and similar). Rate-limit is done at
the Caddy edge (mholt/caddy-ratelimit, 60 req/min/IP), NOT here.

Endpoint is `/excerpts` not `/share/audio/excerpts`. Caddy strips the
`/share/audio` prefix with `handle_path` before reverse-proxying, so
internally we see just `/excerpts`.
"""

from __future__ import annotations

import os
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .logging_setup import (
    bind_request_context,
    clear_request_context,
    get_logger,
    setup_logging,
)
from .pipeline import cut_excerpt, ServiceError


setup_logging(
    service_version=os.environ.get("SERVICE_VERSION", "dev"),
    env=os.environ.get("ENV", "dev"),
    level=os.environ.get("LOG_LEVEL", "info"),
)

log = get_logger(__name__)

app = FastAPI(
    title="lectorium share-audio",
    version="1.0.0",
)


@app.middleware("http")
async def request_logger(request: Request, call_next):
    """One access log line per response, with request_id bound for the
    duration of the request so handler-emitted logs inherit it.

    request_id honours an inbound X-Request-Id (Caddy may set one) or
    mints a fresh one. Echoed in the response header for client-side
    debugging / Datadog correlation.
    """
    request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:12]
    bind_request_context(request_id=request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        log.info(
            "http_request",
            method=request.method,
            path=request.url.path,
            status=getattr(response, "status_code", 500) if "response" in locals() else 500,
            dur_ms=round((time.perf_counter() - started) * 1000, 1),
            remote_ip=_client_ip(request),
        )
        clear_request_context()
    response.headers["X-Request-Id"] = request_id
    return response


def _client_ip(request: Request) -> str:
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# Mirrors the CORS headers the Lambda handler hand-rolled. allow_origins=*
# matches prior behaviour; the actual abuse defence is Caddy rate-limit +
# stream-copy cost being ~zero anyway.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=600,
)


class CutBody(BaseModel):
    source_key: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    excerpt_id: str | None = None


class CutResponse(BaseModel):
    excerpt_id: str
    url: str
    ready: bool


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/excerpts", response_model=CutResponse)
async def post_excerpt(body: CutBody, _: Request) -> CutResponse:
    try:
        result = cut_excerpt(
            source_key=body.source_key,
            start_ms=body.start_ms,
            end_ms=body.end_ms,
            excerpt_id=body.excerpt_id,
        )
    except ValueError as exc:
        # Validation errors from the pipeline (bad ranges, etc.) →
        # 400 with a stable shape clients can read.
        raise HTTPException(status_code=400, detail=str(exc))
    except ServiceError as exc:
        # S3/ffmpeg failures → 502; the upstream isn't us.
        raise HTTPException(status_code=502, detail=str(exc))
    return CutResponse(**result)
