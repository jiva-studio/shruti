"""S3 access for share-transcript.

Replicates the key schemes + semantics the chat service used, so a PDF or
outline already produced by chat is reused verbatim (and vice-versa):

- PDF      `public/tracks/<id>/exports/<lang>.pdf` — `renderer-version`
           travels in object metadata (not the key); a HEAD whose tag
           mismatches the current version is treated as absent so a
           layout bump re-renders in place.
- Outline  `artifacts/tracks/<id>/outlines/<lang>.<model_tag>.c1.json` —
           conditional PUT (`If-None-Match: *`) guards cross-writer races.

boto3 is sync; every call is wrapped through `asyncio.to_thread` so the
FastAPI event loop never blocks on S3 I/O.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

import boto3
from botocore.exceptions import ClientError

from share_transcript.config import Settings


_ABSENT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})

# Bump in lockstep with the renderer's layout: a cached PDF tagged with an
# older version is treated as a cache miss and re-rendered in place. Keep
# this equal to the chat renderer's value so the two share one cache.
PDF_RENDER_VERSION = "v4"
_PDF_VERSION_META = "renderer-version"


class OutlineConflict(Exception):
    """Conditional outline PUT lost the race (another writer got there)."""


def _content_disposition(filename: str) -> str:
    ascii_fallback = (filename.encode("ascii", "ignore").decode("ascii") or "transcript.pdf").replace('"', "")
    return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


class S3:
    def __init__(self, settings: Settings) -> None:
        self._s = settings
        kwargs: dict[str, Any] = {"region_name": settings.s3_region}
        if settings.s3_endpoint_url:
            kwargs["endpoint_url"] = settings.s3_endpoint_url
        self._c = boto3.client("s3", **kwargs)

    # ── keys / urls ──────────────────────────────────────────────────
    @staticmethod
    def pdf_key(track_id: str, lang: str) -> str:
        return f"public/tracks/{track_id}/exports/{lang}.pdf"

    def outline_key(self, track_id: str, lang: str) -> str:
        tag = self._s.llm_outline.replace("/", "_")
        # `.c1` = the two-pass collapse algorithm. Bumping it (here AND in the
        # chat indexer's `_outline_key`, which shares this cache) invalidates
        # outlines produced by the old single-pass generator.
        return f"artifacts/tracks/{track_id}/outlines/{lang}.{tag}.c1.json"

    def public_url(self, key: str) -> str:
        return self._s.public_url(key)

    # ── sync impls ───────────────────────────────────────────────────
    def _pdf_exists(self, track_id: str, lang: str) -> bool:
        try:
            resp = self._c.head_object(Bucket=self._s.s3_bucket, Key=self.pdf_key(track_id, lang))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _ABSENT_CODES:
                return False
            raise
        meta = resp.get("Metadata") or {}
        return meta.get(_PDF_VERSION_META) == PDF_RENDER_VERSION

    def _object_exists(self, key: str) -> bool:
        try:
            self._c.head_object(Bucket=self._s.s3_bucket, Key=key)
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _ABSENT_CODES:
                return False
            raise

    def _get_json(self, key: str) -> dict[str, Any]:
        obj = self._c.get_object(Bucket=self._s.s3_bucket, Key=key)
        return json.loads(obj["Body"].read())

    def _put_pdf(self, track_id: str, lang: str, data: bytes, filename: str) -> None:
        self._c.put_object(
            Bucket=self._s.s3_bucket,
            Key=self.pdf_key(track_id, lang),
            Body=data,
            ContentType="application/pdf",
            ContentDisposition=_content_disposition(filename),
            CacheControl="public, max-age=86400",
            Metadata={_PDF_VERSION_META: PDF_RENDER_VERSION},
        )

    def _outline_exists(self, track_id: str, lang: str) -> bool:
        try:
            self._c.head_object(Bucket=self._s.s3_bucket, Key=self.outline_key(track_id, lang))
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _ABSENT_CODES:
                return False
            raise

    def _get_outline(self, track_id: str, lang: str) -> dict[str, Any]:
        return self._get_json(self.outline_key(track_id, lang))

    def _put_outline(self, track_id: str, lang: str, payload: dict[str, Any], if_none_match: bool) -> None:
        kwargs: dict[str, Any] = {
            "Bucket": self._s.s3_bucket,
            "Key": self.outline_key(track_id, lang),
            "Body": json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "ContentType": "application/json",
        }
        if if_none_match:
            kwargs["IfNoneMatch"] = "*"
        try:
            self._c.put_object(**kwargs)
        except ClientError as exc:
            if if_none_match and exc.response.get("Error", {}).get("Code") in ("PreconditionFailed", "412"):
                raise OutlineConflict(self.outline_key(track_id, lang)) from exc
            raise

    # ── async wrappers ───────────────────────────────────────────────
    async def pdf_exists(self, track_id: str, lang: str) -> bool:
        return await asyncio.to_thread(self._pdf_exists, track_id, lang)

    async def object_exists(self, key: str) -> bool:
        return await asyncio.to_thread(self._object_exists, key)

    async def get_json(self, key: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._get_json, key)

    async def put_pdf(self, track_id: str, lang: str, data: bytes, filename: str) -> None:
        await asyncio.to_thread(self._put_pdf, track_id, lang, data, filename)

    async def outline_exists(self, track_id: str, lang: str) -> bool:
        return await asyncio.to_thread(self._outline_exists, track_id, lang)

    async def get_outline(self, track_id: str, lang: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._get_outline, track_id, lang)

    async def put_outline(self, track_id: str, lang: str, payload: dict[str, Any], *, if_none_match: bool = False) -> None:
        await asyncio.to_thread(self._put_outline, track_id, lang, payload, if_none_match)
