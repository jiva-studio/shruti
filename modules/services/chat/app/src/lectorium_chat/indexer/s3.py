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
