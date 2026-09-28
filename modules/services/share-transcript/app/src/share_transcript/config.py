"""Settings read from the environment once at boot."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_STORAGE_ENDPOINT = "https://storage.bunnycdn.com"


def _env(key: str, default: str = "") -> str:
    v = os.getenv(key)
    return v.strip() if v and v.strip() else default


@dataclass(frozen=True, slots=True)
class Settings:
    env: str
    service_version: str
    log_level: str
    port: int

    storage_zone: str
    storage_key: str
    storage_endpoint: str
    # The pull zone in front of the storage zone; returned PDF URLs are
    # composed from it.
    public_base: str

    def public_url(self, key: str) -> str:
        return self.public_base.rstrip("/") + "/" + key


def load() -> Settings:
    required = {
        "STORAGE_ZONE": _env("STORAGE_ZONE"),
        "STORAGE_KEY": _env("STORAGE_KEY"),
        "PDFS_PUBLIC_BASE": _env("PDFS_PUBLIC_BASE"),
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise RuntimeError(f"{', '.join(missing)} must be set")
    return Settings(
        env=_env("ENV", "dev"),
        service_version=_env("SERVICE_VERSION", "dev"),
        log_level=_env("LOG_LEVEL", "info"),
        port=int(_env("PORT", "8084")),
        storage_zone=required["STORAGE_ZONE"],
        storage_key=required["STORAGE_KEY"],
        storage_endpoint=_env("STORAGE_ENDPOINT", DEFAULT_STORAGE_ENDPOINT),
        public_base=required["PDFS_PUBLIC_BASE"],
    )
