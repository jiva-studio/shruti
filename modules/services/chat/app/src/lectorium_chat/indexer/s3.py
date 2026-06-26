"""Catalog/transcript access for the indexer.

Everything is read over plain HTTPS from the media CDN (Bunny.net) — no S3
SDK, no credentials, no anonymous-listing requirement:
- read `public/config.json` (catalog + library manifests)
- download `public/db/lectorium.{ver}.db` / `public/library/library.{ver}.db`
- discover transcripts + their change-token from the published catalog db's
  `asset_hashes` table (populated by lectorium-mcp), instead of listing S3.
  Bunny Edge Storage has no anonymous object listing, and the catalog db —
  which we already download — knows every transcript and its content hash.
- fetch one transcript JSON by key.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import aiofiles
import httpx

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


@dataclass
class TranscriptObject:
    track_id: str
    lang: str
    key: str
    etag: str  # content sha256 from asset_hashes (was the S3 ETag)


@dataclass
class CatalogManifestEntry:
    version: str
    scheme: int | None = None


def _media_base(s: Settings) -> str:
    return s.media_base_url.rstrip("/")


async def read_catalog_manifest(settings: Settings | None = None) -> list[CatalogManifestEntry]:
    """Pull public/config.json and parse the databases array.

    Real shape:
        {"databases": [{"version": 20260513064605, "scheme": 20260512}, ...]}
    """
    s = settings or get_settings()
    url = f"{_media_base(s)}/public/config.json"
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
    url = f"{_media_base(s)}/public/db/lectorium.{version}.db"
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
    url = f"{_media_base(s)}/public/config.json"
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
    url = f"{_media_base(s)}/public/library/library.{version}.db"
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            async with aiofiles.open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1 << 20):
                    await f.write(chunk)


def list_transcripts(langs: list[str], settings: Settings | None = None) -> list[TranscriptObject]:
    """Discover transcripts + their content hash from the published catalog db.

    Reads the `asset_hashes` table (kind='transcript') out of the local
    catalog.db that `catalog.ensure_catalog` already downloaded — no S3 list,
    no credentials. `etag` carries the sha256 change-token the caller diffs
    against `indexed_items.etag`. Returns [] (with a warning) when the table is
    absent, i.e. the published catalog predates the asset_hashes schema — in
    that case republish from lectorium-mcp.

    Synchronous — sqlite is sync, and we call this from a worker thread.
    """
    s = settings or get_settings()
    db_path = s.catalog_db_path
    wanted = set(langs)
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.OperationalError as exc:
        log.warning("catalog_db_unavailable", path=str(db_path), error=str(exc))
        return []
    try:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT track_id, language, path, sha256 "
                "FROM asset_hashes WHERE kind = 'transcript'"
            ).fetchall()
        except sqlite3.OperationalError as exc:
            log.warning(
                "asset_hashes_missing",
                error=str(exc),
                hint="republish catalog from lectorium-mcp (asset_hashes schema)",
            )
            return []
    finally:
        conn.close()
    return [
        TranscriptObject(track_id=r["track_id"], lang=r["language"],
                         key=r["path"], etag=r["sha256"])
        for r in rows
        if r["language"] in wanted
    ]


async def fetch_transcript(key: str, settings: Settings | None = None) -> dict:
    """Download a transcript JSON and parse it."""
    s = settings or get_settings()
    url = f"{_media_base(s)}/{key.lstrip('/')}"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(url)
        r.raise_for_status()
        return json.loads(r.text)
