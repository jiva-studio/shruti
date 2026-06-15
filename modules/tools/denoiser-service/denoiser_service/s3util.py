"""S3 / HTTP I/O: download the input from a (public) URL, upload the result to
an S3-compatible destination using per-job credentials."""
from __future__ import annotations

import shutil
import urllib.request

import boto3
from botocore.config import Config as BotoConfig

from .models import S3Dest, S3Source

_DOWNLOAD_TIMEOUT = 300  # seconds for the initial GET


def _client(*, region, endpoint_url, access_key_id, secret_access_key):
    return boto3.client(
        "s3",
        region_name=region,
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
    )


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
    client = _client(
        region=dest.region, endpoint_url=dest.endpoint_url,
        access_key_id=dest.access_key_id, secret_access_key=dest.secret_access_key,
    )
    extra: dict[str, str] = {"ContentType": dest.content_type}
    if dest.acl:
        extra["ACL"] = dest.acl
    client.upload_file(local_path, dest.bucket, dest.key, ExtraArgs=extra)
    return dest.public_url()


def list_objects(src: S3Source, *, limit: int = 100000) -> list[dict[str, object]]:
    """List objects under src.bucket/src.prefix. Returns [{key, size}], paginated."""
    client = _client(
        region=src.region, endpoint_url=src.endpoint_url,
        access_key_id=src.access_key_id, secret_access_key=src.secret_access_key,
    )
    out: list[dict[str, object]] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=src.bucket, Prefix=src.prefix or ""):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):  # skip "directory" markers
                continue
            out.append({"key": key, "size": obj["Size"]})
            if len(out) >= limit:
                return out
    return out


def presign_get(src: S3Source, key: str, expiry_s: int) -> str:
    """Presigned GET URL so the (plain-GET) worker can fetch a private object."""
    client = _client(
        region=src.region, endpoint_url=src.endpoint_url,
        access_key_id=src.access_key_id, secret_access_key=src.secret_access_key,
    )
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": src.bucket, "Key": key}, ExpiresIn=expiry_s
    )
