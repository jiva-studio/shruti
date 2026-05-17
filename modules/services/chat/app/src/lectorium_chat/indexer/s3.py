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
