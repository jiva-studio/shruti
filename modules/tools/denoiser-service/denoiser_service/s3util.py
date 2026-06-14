"""S3 / HTTP I/O: download the input from a (public) URL, upload the result to
an S3-compatible destination using per-job credentials."""
from __future__ import annotations

import shutil
import urllib.request

import boto3
from botocore.config import Config as BotoConfig

from .models import S3Dest

_DOWNLOAD_TIMEOUT = 300  # seconds for the initial GET


def download(url: str, dest_path: str) -> None:
    """Stream an HTTP(S) URL to a local file. Raises on non-2xx / network error."""
    req = urllib.request.Request(url, headers={"User-Agent": "denoiser-service/0.1"})
    with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as resp:  # noqa: S310
        status = getattr(resp, "status", 200)
        if status and status >= 400:
            raise RuntimeError(f"download {url}: HTTP {status}")
        with open(dest_path, "wb") as out:
            shutil.copyfileobj(resp, out)


def upload(local_path: str, dest: S3Dest) -> str:
    """Upload a local file to the S3 destination. Returns the object URL."""
    client = boto3.client(
        "s3",
        region_name=dest.region,
        endpoint_url=dest.endpoint_url,
        aws_access_key_id=dest.access_key_id,
        aws_secret_access_key=dest.secret_access_key,
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
    )
    extra: dict[str, str] = {"ContentType": dest.content_type}
    if dest.acl:
        extra["ACL"] = dest.acl
    client.upload_file(local_path, dest.bucket, dest.key, ExtraArgs=extra)
    return dest.public_url()
