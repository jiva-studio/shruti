"""Request/response DTOs and the persisted Job record.

Secrets (S3 access keys) deliberately never appear in the persisted ``Job`` —
they ride in the request, are held in memory only for the duration of the run,
and are dropped once the job finishes. See store.py / worker.py.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class Status(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class S3Dest(BaseModel):
    """Where the denoised file is uploaded. Credentials are S3-compatible
    (AWS, Yandex Object Storage, MinIO, …) via the optional endpoint_url."""

    bucket: str = Field(..., description="Destination S3 bucket.")
    key: str = Field(..., description="Destination object key, e.g. 'clean/lecture.mp3'.")
    access_key_id: str = Field(..., description="S3 access key id.")
    secret_access_key: str = Field(..., description="S3 secret access key.")
    region: Optional[str] = Field(None, description="Region, e.g. 'ru-central1' or 'us-east-1'.")
    endpoint_url: Optional[str] = Field(
        None,
        description="Custom S3 endpoint for non-AWS providers "
        "(e.g. https://storage.yandexcloud.net). Omit for AWS.",
    )
    acl: Optional[str] = Field(None, description="Optional canned ACL, e.g. 'public-read'.")
    content_type: str = Field("audio/mpeg", description="Content-Type set on the uploaded object.")

    def public_url(self) -> str:
        if self.endpoint_url:
            base = self.endpoint_url.rstrip("/")
            return f"{base}/{self.bucket}/{self.key}"
        if self.region:
            return f"https://{self.bucket}.s3.{self.region}.amazonaws.com/{self.key}"
        return f"https://{self.bucket}.s3.amazonaws.com/{self.key}"


class DenoiseParams(BaseModel):
    """Knobs forwarded to denoise_mp3.py. Defaults match the script."""

    strategy: str = Field(
        "afftdn",
        description="Cleaning strategy: 'afftdn' (default, ffmpeg FFT denoise — "
        "fast, no dead pauses), 'rnnoise' (RNNoise, aggressive), or 'rnnoise-mix' "
        "(RNNoise blended back with the original by voice probability).",
    )
    # afftdn knobs
    nr: float = Field(
        12.0, ge=0.01, le=97.0,
        description="afftdn: noise reduction in dB — higher is more aggressive. Default 12.",
    )
    nf: float = Field(-25.0, description="afftdn: noise floor estimate in dB. Default -25.")
    # rnnoise-mix knobs (ratio of original blended back)
    mix_min: float = Field(
        0.10, ge=0.0, le=1.0,
        description="rnnoise-mix: original ratio in pauses (no voice). Default 0.10.",
    )
    mix_max: float = Field(
        0.25, ge=0.0, le=1.0,
        description="rnnoise-mix: original ratio on voice. Default 0.25.",
    )


class CreateJobRequest(BaseModel):
    source_url: str = Field(
        ...,
        description="HTTP(S) URL of the input audio (e.g. a public S3 object). "
        "Downloaded by the service.",
    )
    dest: S3Dest
    filename: Optional[str] = Field(None, description="Display name; defaults to the URL basename.")
    params: DenoiseParams = Field(default_factory=DenoiseParams)


class CreateJobResponse(BaseModel):
    job_id: str
    status: Status
    filename: str


class S3Source(BaseModel):
    """A source bucket + prefix to enumerate, with read/list credentials.
    Used for batch fan-out (list objects, presign each for the worker)."""

    bucket: str
    prefix: str = ""
    access_key_id: str
    secret_access_key: str
    region: Optional[str] = None
    endpoint_url: Optional[str] = None


class ListObjectsRequest(BaseModel):
    source: S3Source
    limit: int = Field(100000, ge=1, le=1000000)


class ListObjectsResponse(BaseModel):
    count: int
    objects: list[dict[str, Any]]


class BatchItem(BaseModel):
    source_url: str
    dest_key: str
    filename: Optional[str] = None


class BatchRequest(BaseModel):
    """Two modes (mutually exclusive):

    - explicit: provide ``items`` (each source_url + dest_key).
    - enumerate: provide ``source`` (bucket+prefix+creds) + ``dest_prefix``; the
      service lists the prefix and presigns a GET URL for every object.
    """

    dest: S3Dest = Field(..., description="Upload creds + bucket; per-item key is derived.")
    params: DenoiseParams = Field(default_factory=DenoiseParams)

    items: Optional[list[BatchItem]] = None

    source: Optional[S3Source] = None
    dest_prefix: str = Field("clean/", description="Enumerate mode: prefix for output keys.")
    presign_expiry_s: int = Field(86400, ge=60, description="Enumerate mode: presigned-URL TTL.")
    limit: int = Field(100000, ge=1, le=1000000, description="Enumerate mode: max objects.")


class BatchResponse(BaseModel):
    count: int
    job_ids: list[str]


class HealthResponse(BaseModel):
    workers: int
    queued: int
    running: int
    done: int
    failed: int
    denoiser_ready: bool
    uptime_s: int


@dataclass
class Job:
    """Canonical persisted record. Time fields are unix milliseconds.

    Note the absence of any credential field — by design.
    """

    job_id: str
    filename: str
    source_url: str
    dest_bucket: str
    dest_key: str
    status: Status = Status.QUEUED
    uploaded_at: int = 0
    started_at: Optional[int] = None
    completed_at: Optional[int] = None
    duration_seconds: Optional[float] = None
    processing_time_seconds: Optional[float] = None
    rtfx: Optional[float] = None
    dest_url: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["status"] = self.status.value
        return {k: v for k, v in d.items() if v is not None}
