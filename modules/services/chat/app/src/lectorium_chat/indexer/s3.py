"""S3 access helpers.

Three operations we need:
- read `public/config.json` (catalog manifest)
- download a `public/db/lectorium.{ver}.db` file
- list+HEAD `public/tracks/<id>/transcripts/<lang>.json` (with ETag)

For the catalog DB and transcripts the public URL is fine (no signing). We
still use boto3 for ETag/listing because anonymous list isn't always
permitted — the IAM key has list permission, anonymous HTTP does not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import aiofiles
import boto3
import httpx
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


@dataclass
class TranscriptObject:
    track_id: str
    lang: str
    key: str
    etag: str


@dataclass
class CatalogManifestEntry:
    version: str
    scheme: int | None = None


def _make_s3_client(settings: Settings):
    return boto3.client(
        "s3",
        region_name=settings.s3_region,
        endpoint_url=settings.s3_endpoint or None,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=BotoConfig(retries={"max_attempts": 5, "mode": "standard"}),
    )


async def read_catalog_manifest(settings: Settings | None = None) -> list[CatalogManifestEntry]:
    """Pull public/config.json and parse the databases array.

    Real shape:
        {"databases": [{"version": 20260513064605, "scheme": 20260512}, ...]}
    """
    s = settings or get_settings()
    url = f"{s.s3_public_url}/public/config.json"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    if isinstance(data, dict):
        items_raw = data.get("databases") or data.get("versions") or []
    else:
        items_raw = data
    return [CatalogManifestEntry(version=str(it["version"]), scheme=it.get("scheme"))
            for it in items_raw if isinstance(it, dict)]


async def download_catalog(version: str, dest: Path, settings: Settings | None = None) -> None:
    """Download public/db/lectorium.{version}.db to `dest` (streamed)."""
    s = settings or get_settings()
    url = f"{s.s3_public_url}/public/db/lectorium.{version}.db"
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            async with aiofiles.open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1 << 20):  # 1 MiB
                    await f.write(chunk)


# ── Library DB manifest + fetch ────────────────────────────────────────
#
# library.db lives under `public/library/library.{version}.db` and is
# advertised via the `library.versions[]` array inside `public/config.json`
# (set by the `library.publish` MCP tool — independent of the catalog
# version ladder).


@dataclass
class LibraryManifestEntry:
    version: str


async def read_library_manifest(settings: Settings | None = None) -> list[LibraryManifestEntry]:
    """Pull public/config.json and parse the library.versions array.

    Real shape (inside the same config.json the catalog uses):
        {"library": {"versions": [{"version": 20260519144040}, ...]}}
    Returns an empty list if the `library` field is absent (config.json
    written by an older publisher).
    """
    s = settings or get_settings()
    url = f"{s.s3_public_url}/public/config.json"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    if not isinstance(data, dict):
        return []
    lib = data.get("library")
    if not isinstance(lib, dict):
        return []
    items_raw = lib.get("versions") or []
    return [LibraryManifestEntry(version=str(it["version"]))
            for it in items_raw if isinstance(it, dict)]


async def download_library(version: str, dest: Path, settings: Settings | None = None) -> None:
    """Download public/library/library.{version}.db to `dest` (streamed)."""
    s = settings or get_settings()
    url = f"{s.s3_public_url}/public/library/library.{version}.db"
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            async with aiofiles.open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1 << 20):
                    await f.write(chunk)


def list_transcripts(langs: list[str], settings: Settings | None = None) -> list[TranscriptObject]:
    """Enumerate public/tracks/<id>/transcripts/<lang>.json objects with ETags.

    Synchronous — boto3 paginator is sync, and we call this from a worker.
    """
    s = settings or get_settings()
    client = _make_s3_client(s)
    paginator = client.get_paginator("list_objects_v2")
    out: list[TranscriptObject] = []
    suffixes = {f"/transcripts/{lang}.json": lang for lang in langs}
    for page in paginator.paginate(Bucket=s.s3_bucket, Prefix="public/tracks/"):
        for obj in page.get("Contents", []) or []:
            key: str = obj["Key"]
            etag: str = obj["ETag"].strip('"')
            for suf, lang in suffixes.items():
                if key.endswith(suf):
                    # key: public/tracks/<track_id>/transcripts/<lang>.json
                    parts = key.split("/")
                    track_id = parts[2]
                    out.append(TranscriptObject(
                        track_id=track_id, lang=lang, key=key, etag=etag,
                    ))
                    break
    return out


async def fetch_transcript(key: str, settings: Settings | None = None) -> dict:
    """Download a transcript JSON and parse it."""
    s = settings or get_settings()
    url = f"{s.s3_public_url}/{key}"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(url)
        r.raise_for_status()
        return json.loads(r.text)


# -----------------------------------------------------------------------------
# Internal-artifact helpers (chat-agent writes outlines into `artifacts/`).
# Unlike `public/`, this prefix isn't anonymously readable — go via the IAM
# client (boto3) for both HEAD and GET. PUT requires `s3:PutObject` on
# `artifacts/tracks/*/outlines/*`.
# -----------------------------------------------------------------------------


def outline_model_tag(model: str) -> str:
    """S3-safe filename segment derived from the litellm/openrouter model id.

    `openrouter/google/gemini-2.0-flash-001` → `openrouter_google_gemini-2.0-flash-001`.
    Slashes become underscores; everything else passes through. The tag
    is embedded in the artifact key so a model upgrade (config change to
    `llm_outline`) starts a fresh cache — old outlines stay reachable
    under the old key for rollback, but no read path touches them.
    """
    return model.replace("/", "_")


def _outline_key(track_id: str, lang: str, settings: Settings) -> str:
    tag = outline_model_tag(settings.llm_outline)
    return f"artifacts/tracks/{track_id}/outlines/{lang}.{tag}.json"


_S3_ABSENT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})


def outline_exists_sync(track_id: str, lang: str, settings: Settings | None = None) -> bool:
    """HEAD the outline artifact for the current `llm_outline` model.

    Returns False on a true 404 / NoSuchKey; re-raises on every other
    error (network blip, signature error, etc.) so the caller can decide
    whether to retry rather than silently treating a transient failure
    as "not present" and triggering a redundant cold-path generation.
    """
    s = settings or get_settings()
    client = _make_s3_client(s)
    key = _outline_key(track_id, lang, s)
    try:
        client.head_object(Bucket=s.s3_bucket, Key=key)
        return True
    except ClientError as exc:
        err = exc.response.get("Error", {})
        if err.get("Code") in _S3_ABSENT_CODES:
            return False
        raise


def get_outline_sync(track_id: str, lang: str, settings: Settings | None = None) -> dict:
    """GET the outline artifact for the current `llm_outline` model."""
    s = settings or get_settings()
    client = _make_s3_client(s)
    key = _outline_key(track_id, lang, s)
    obj = client.get_object(Bucket=s.s3_bucket, Key=key)
    return json.loads(obj["Body"].read())


class OutlineAlreadyExists(Exception):
    """Raised by `put_outline_sync(if_none_match=True)` when another writer
    won the race (S3 PreconditionFailed on the conditional PUT)."""


def put_outline_sync(
    track_id: str,
    lang: str,
    payload: dict,
    settings: Settings | None = None,
    *,
    if_none_match: bool = False,
) -> None:
    """PUT the outline artifact under the current `llm_outline` model tag.

    With `if_none_match=True`, sends `If-None-Match: *` so the PUT is
    rejected with 412 PreconditionFailed if the key already exists. We
    raise `OutlineAlreadyExists` in that case so the caller can refetch
    the winning writer's payload instead of overwriting it.
    """
    s = settings or get_settings()
    client = _make_s3_client(s)
    key = _outline_key(track_id, lang, s)
    kwargs: dict = {
        "Bucket": s.s3_bucket,
        "Key": key,
        "Body": json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        "ContentType": "application/json",
    }
    if if_none_match:
        kwargs["IfNoneMatch"] = "*"
    try:
        client.put_object(**kwargs)
    except ClientError as exc:
        err = exc.response.get("Error", {})
        if if_none_match and err.get("Code") in ("PreconditionFailed", "412"):
            raise OutlineAlreadyExists(key) from exc
        raise


# -----------------------------------------------------------------------------
# Public-export helpers — printable PDF derived from a transcript. Unlike
# outlines (internal under `artifacts/`), these live under `public/` so the
# mobile client can hand the URL straight to the platform share sheet
# without proxying through us.
#
# `_PDF_RENDER_VERSION` lives in S3 object metadata (`x-amz-meta-renderer-
# version`), NOT in the object key. Earlier iterations put the version
# in the filename which left every previous version sitting as an
# orphan after a layout change; the metadata-only approach lets the
# PUT clobber the same key on regen and keeps `public/tracks/<id>/
# exports/` clean (one PDF per language, full stop). HEAD reads the
# metadata and treats a version mismatch the same as a 404.
# -----------------------------------------------------------------------------


_PDF_RENDER_VERSION = "v4"
_PDF_VERSION_META_KEY = "renderer-version"


def track_pdf_key(track_id: str, lang: str) -> str:
    return f"public/tracks/{track_id}/exports/{lang}.pdf"


def track_pdf_public_url(track_id: str, lang: str, settings: Settings | None = None) -> str:
    s = settings or get_settings()
    return f"{s.s3_public_url}/{track_pdf_key(track_id, lang)}"


def track_pdf_exists_sync(
    track_id: str, lang: str, settings: Settings | None = None,
) -> bool:
    """HEAD the PDF artifact + check the renderer-version tag.

    Returns False on a true 404 / NoSuchKey OR when the cached
    object was rendered by an older renderer version. Re-raises on
    every other error so the caller can decide whether to retry
    rather than silently treating a transient failure as "absent"
    and triggering a redundant cold-path regeneration."""
    s = settings or get_settings()
    client = _make_s3_client(s)
    key = track_pdf_key(track_id, lang)
    try:
        resp = client.head_object(Bucket=s.s3_bucket, Key=key)
    except ClientError as exc:
        err = exc.response.get("Error", {})
        if err.get("Code") in _S3_ABSENT_CODES:
            return False
        raise
    meta = resp.get("Metadata") or {}
    # boto3 lowercases user-metadata keys on the way back. Treat a
    # missing tag as "older than we track" → regen.
    return meta.get(_PDF_VERSION_META_KEY) == _PDF_RENDER_VERSION


def put_track_pdf_sync(
    track_id: str, lang: str, pdf_bytes: bytes, settings: Settings | None = None,
    *, download_filename: str | None = None,
) -> None:
    """PUT the PDF under the canonical key. Always overwrites — the
    artifact is content-addressed only by `(track_id, lang)`, so a
    regeneration replaces it in place. The renderer-version tag
    travels in object metadata, NOT in the key, so a layout bump
    invalidates the cache without leaving an orphan behind."""
    s = settings or get_settings()
    client = _make_s3_client(s)
    key = track_pdf_key(track_id, lang)
    fname = download_filename or f"{track_id}.{lang}.pdf"
    client.put_object(
        Bucket=s.s3_bucket,
        Key=key,
        Body=pdf_bytes,
        ContentType="application/pdf",
        ContentDisposition=_content_disposition_for(fname),
        CacheControl="public, max-age=86400",
        Metadata={_PDF_VERSION_META_KEY: _PDF_RENDER_VERSION},
    )


def _content_disposition_for(filename: str) -> str:
    """RFC 5987-compliant `inline; filename=...; filename*=UTF-8''...`.

    `filename` carries the human-readable name with Cyrillic / IAST
    diacritics intact; `filename` (legacy) gets an ASCII-only fallback
    so old downloaders that ignore the `*` form still see something
    sensible. Modern share sheets / browsers honour the `*` form.
    """
    from urllib.parse import quote
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "transcript.pdf"
    ascii_fallback = ascii_fallback.replace('"', "")
    return (
        f'inline; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )
