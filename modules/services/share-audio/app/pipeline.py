"""Cut-and-upload pipeline. Pure functions, no HTTP framework coupling.

Built on top of the legacy storage module that the old Lambda handler
used. Same behaviour:
  - idempotent on excerpt_id (HEAD probe before doing work)
  - ffmpeg -c copy (stream-copy, no re-encode — sub-second)
  - upload result back to the same bucket under EXCERPTS_PREFIX
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from storage import build_excerpt_url, get_storage_client

from .logging_setup import get_logger


log = get_logger(__name__)


BUCKET = os.environ.get("BUCKET") or os.environ.get("LECTORIUM_S3_BUCKET", "")
EXCERPTS_PREFIX = os.environ.get("EXCERPTS_PREFIX", "public/shares/audio")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "/usr/bin/ffmpeg")

# Cap by container — mobile sends <60s clips in practice; 10 minutes is
# a safety net to prevent abuse. Same number the Lambda handler used.
MAX_EXCERPT_MS = 10 * 60 * 1000


class ServiceError(RuntimeError):
    """S3 or ffmpeg failure that's the upstream's fault, not the caller's."""


def cut_excerpt(
    *,
    source_key: str,
    start_ms: int,
    end_ms: int,
    excerpt_id: str | None = None,
) -> dict:
    """Cut [start_ms, end_ms) out of `source_key` and upload as an MP3.

    Returns {"excerpt_id", "url", "ready"}. Idempotent: if the destination
    object exists (probably the same excerpt was requested before), skip
    the cut and return its URL.
    """
    if not BUCKET:
        raise ServiceError("BUCKET env var is required")
    if end_ms <= start_ms:
        raise ValueError("end_ms must be greater than start_ms")
    if (end_ms - start_ms) > MAX_EXCERPT_MS:
        raise ValueError(f"excerpt longer than {MAX_EXCERPT_MS // 60_000} minutes is not supported")
    if excerpt_id is not None and not _is_safe_id(excerpt_id):
        raise ValueError("excerpt_id must be alphanumeric / dash / underscore (≤64 chars)")

    eid = excerpt_id or uuid.uuid4().hex
    key = f"{EXCERPTS_PREFIX}/{eid}.mp3"
    storage = get_storage_client()

    if _object_exists(storage, BUCKET, key):
        return {
            "excerpt_id": eid,
            "url": build_excerpt_url(BUCKET, key),
            "ready": True,
        }

    with tempfile.TemporaryDirectory() as tmp:
        src_path = Path(tmp) / "source.mp3"
        out_path = Path(tmp) / "excerpt.mp3"
        log.info("excerpt_download_start", bucket=BUCKET, source_key=source_key, excerpt_id=eid)
        try:
            storage.download_file(BUCKET, source_key, str(src_path))
        except Exception as exc:  # noqa: BLE001 — boto3 ClientError + friends
            log.error("excerpt_download_failed", bucket=BUCKET, source_key=source_key, err=str(exc))
            raise ServiceError(f"download failed: {exc}") from exc

        try:
            _cut(src_path, out_path, start_ms, end_ms)
        except subprocess.CalledProcessError as exc:
            log.error("ffmpeg_failed", returncode=exc.returncode, excerpt_id=eid)
            raise ServiceError(f"ffmpeg failed: rc={exc.returncode}") from exc

        log.info("excerpt_upload_start", bucket=BUCKET, key=key, excerpt_id=eid)
        try:
            storage.upload_file(
                str(out_path),
                BUCKET,
                key,
                ExtraArgs={"ContentType": "audio/mpeg"},
            )
        except Exception as exc:  # noqa: BLE001
            log.error("excerpt_upload_failed", bucket=BUCKET, key=key, err=str(exc))
            raise ServiceError(f"upload failed: {exc}") from exc
        log.info("excerpt_done", excerpt_id=eid, key=key)

    return {
        "excerpt_id": eid,
        "url": build_excerpt_url(BUCKET, key),
        "ready": True,
    }


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


def _is_safe_id(value: str) -> bool:
    return bool(value) and all(c.isalnum() or c in "-_" for c in value) and len(value) <= 64
