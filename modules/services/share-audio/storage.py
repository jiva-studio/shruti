"""S3 client + URL builder for AWS S3.

On AWS Lambda the client uses the function's IAM role (no static keys).
On Yandex Cloud Functions the client picks up AWS_* env vars set by the
serverless config (a dedicated IAM user with S3 read on source / write on
excerpts).
"""

from __future__ import annotations

import os
from functools import lru_cache

import boto3
from botocore.config import Config


@lru_cache(maxsize=1)
def get_storage_client():
    # S3_ENDPOINT_URL lets the same client talk to a non-AWS S3-compatible
    # store (used on YC: https://storage.yandexcloud.net). Unset on AWS →
    # boto3 picks the real AWS endpoint per region.
    endpoint_url = os.environ.get("S3_ENDPOINT_URL") or None
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        config=Config(
            retries={"max_attempts": 3, "mode": "standard"},
            signature_version="s3v4",
        ),
    )


def build_excerpt_url(bucket: str, key: str) -> str:
    """Stable public URL for the excerpt object.

    Prefer EXCERPTS_PUBLIC_BASE if set (e.g. CloudFront domain). Otherwise
    fall back to the virtual-hosted S3 URL.
    """
    base = os.environ.get("EXCERPTS_PUBLIC_BASE")
    if base:
        return f"{base.rstrip('/')}/{key}"
    region = os.environ.get("AWS_REGION", "us-east-1")
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
