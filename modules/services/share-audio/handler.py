"""Cut a fragment from an MP3 stored in AWS S3 and upload it back as a public excerpt.

The same handler runs unchanged on AWS Lambda and Yandex Cloud Functions.
Source and excerpt live in the same single bucket; excerpts go under
EXCERPTS_PREFIX (default `public/shares/audio`).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from event_adapter import parse_request
from storage import build_excerpt_url, get_storage_client

log = logging.getLogger()
log.setLevel(logging.INFO)

BUCKET = os.environ["BUCKET"]
EXCERPTS_PREFIX = os.environ.get("EXCERPTS_PREFIX", "public/shares/audio")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "/opt/bin/ffmpeg")


def handler(event, context):  # noqa: ANN001 — cloud SDKs pass arbitrary dicts
    # CORS preflight — browser-served clients (mobile web build, `ionic
    # serve`) send an OPTIONS before the POST. Answer it directly; AWS
    # HTTP API's built-in cors handles its own preflight, but the YC
    # Function delivers OPTIONS to the handler, so we have to.
    method = _request_method(event)
    if method == "OPTIONS":
        return _response(204, None)

    try:
        req = parse_request(event)
    except ValueError as exc:
        return _response(400, {"error": str(exc)})

    excerpt_id = req.excerpt_id or uuid.uuid4().hex
    storage = get_storage_client()
    excerpt_key = f"{EXCERPTS_PREFIX}/{excerpt_id}.mp3"

    if _object_exists(storage, BUCKET, excerpt_key):
        return _response(200, {
            "excerpt_id": excerpt_id,
            "url": build_excerpt_url(BUCKET, excerpt_key),
            "ready": True,
        })

    with tempfile.TemporaryDirectory() as tmp:
        src_path = Path(tmp) / "source.mp3"
        out_path = Path(tmp) / "excerpt.mp3"
        log.info("downloading s3://%s/%s", BUCKET, req.source_key)
        storage.download_file(BUCKET, req.source_key, str(src_path))
        _cut(src_path, out_path, req.start_ms, req.end_ms)
        log.info("uploading s3://%s/%s", BUCKET, excerpt_key)
        storage.upload_file(
            str(out_path),
            BUCKET,
            excerpt_key,
            ExtraArgs={"ContentType": "audio/mpeg"},
        )

    return _response(200, {
        "excerpt_id": excerpt_id,
        "url": build_excerpt_url(BUCKET, excerpt_key),
        "ready": True,
    })


def _cut(src: Path, dst: Path, start_ms: int, end_ms: int) -> None:
    duration_s = (end_ms - start_ms) / 1000
    start_s = start_ms / 1000
    cmd = [
        FFMPEG_BIN, "-nostdin", "-y",
        "-ss", f"{start_s:.3f}",
        "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-c", "copy",
        "-loglevel", "error",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def _object_exists(client, bucket: str, key: str) -> bool:
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except client.exceptions.ClientError:
        return False


_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
}


def _request_method(event) -> str:  # noqa: ANN001
    # AWS HTTP API v2: event.requestContext.http.method
    # Direct invoke / YC: event.httpMethod or event.request_context.http_method
    ctx = event.get("requestContext", {}) if isinstance(event, dict) else {}
    http = ctx.get("http") if isinstance(ctx, dict) else None
    if isinstance(http, dict) and "method" in http:
        return str(http["method"]).upper()
    if isinstance(event, dict) and "httpMethod" in event:
        return str(event["httpMethod"]).upper()
    return ""


def _response(status: int, body):  # noqa: ANN001 — `body` is dict|None
    headers = {"Content-Type": "application/json", **_CORS_HEADERS}
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body) if body is not None else "",
    }
