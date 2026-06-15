"""Env-driven config. Same var names as share-audio / share-video so a
shared `.env` and the compose translation layer keep working."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(key: str, default: str = "") -> str:
    v = os.getenv(key)
    return v.strip() if v and v.strip() else default


def _first(*keys: str) -> str:
    for k in keys:
        v = os.getenv(k)
        if v and v.strip():
            return v.strip()
    return ""


@dataclass(frozen=True, slots=True)
class Settings:
    env: str
    service_version: str
    log_level: str
    port: int

    s3_bucket: str
    s3_region: str
    # "" → AWS default endpoint. Set to https://storage.yandexcloud.net on RU.
    s3_endpoint_url: str
    # Public CDN base for the returned PDF URL. "" → derive the AWS
    # virtual-hosted form. MUST be set whenever s3_endpoint_url is (else
    # the URL points at AWS for a file that lives on Yandex).
    s3_public_base: str
    # POST /pdf rejects a transcript_key outside this prefix before any
    # S3 GET — defence in depth against probing sibling prefixes.
    source_key_prefix: str

    def public_url(self, key: str) -> str:
        if self.s3_public_base:
            return self.s3_public_base.rstrip("/") + "/" + key
        return f"https://{self.s3_bucket}.s3.{self.s3_region}.amazonaws.com/{key}"


def load() -> Settings:
    bucket = _first("LECTORIUM_S3_BUCKET", "BUCKET")
    if not bucket:
        raise RuntimeError("LECTORIUM_S3_BUCKET (or BUCKET) is required")
    endpoint = _env("S3_ENDPOINT_URL")
    public_base = _first("PDFS_PUBLIC_BASE", "LECTORIUM_S3_PUBLIC_BASE")
    # A non-AWS endpoint (RU → Yandex) MUST come with a matching public
    # base, or the returned PDF URLs point at AWS for objects on the
    # alternate endpoint — the mobile warm-cache probe never matches and
    # every share cold-renders (and the URL may 404). Fail loudly rather
    # than silently emit wrong URLs.
    if endpoint and not public_base:
        raise RuntimeError(
            "S3_ENDPOINT_URL is set but PDFS_PUBLIC_BASE / "
            "LECTORIUM_S3_PUBLIC_BASE is empty — returned PDF URLs would "
            "point at AWS for objects on the alternate endpoint"
        )
    return Settings(
        env=_env("ENV", "dev"),
        service_version=_env("SERVICE_VERSION", "dev"),
        log_level=_env("LOG_LEVEL", "info"),
        port=int(_env("PORT", "8084")),
        s3_bucket=bucket,
        s3_region=_env("AWS_REGION", "us-east-1"),
        s3_endpoint_url=endpoint,
        s3_public_base=public_base,
        source_key_prefix=_env("SOURCE_KEY_PREFIX", "public/tracks/"),
    )
