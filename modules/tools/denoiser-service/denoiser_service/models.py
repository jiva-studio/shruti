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
    """Knobs forwarded to denoise_mp3.py. Defaults match the script's defaults."""

    normalize: bool = Field(True, description="Dynamic volume normalization.")
    noise_profile: bool = Field(
        False,
        description="Apply spectral subtraction using the bundled noise-profile.wav "
        "(slower — see README; roughly triples processing time).",
    )
    mix_min: float = Field(
        0.0, ge=0.0, le=100.0,
        description="%% of original audio mixed back where NO voice is detected (0-100).",
    )
    mix_max: float = Field(
        0.0, ge=0.0, le=100.0,
        description="%% of original audio mixed back where voice IS detected (0-100).",
    )
    sample_rate: int = Field(48000, description="Processing sample rate (RNNoise native = 48000).")


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
