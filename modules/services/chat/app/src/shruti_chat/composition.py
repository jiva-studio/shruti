"""Composition root — assembles `AppDeps` from settings + concrete adapters.

`AppDeps` is the only place infrastructure objects live as long-lived
references; FastAPI routes pull them via `Depends(get_deps)`. Replacing
an adapter (e.g. for tests) means building an `AppDeps` instance with
fake repos and stuffing it into `app.state.deps`.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg
from fastapi import Request

from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.config import Settings
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort
from shruti_chat.domain.ports.outline_cache import OutlineCache
from shruti_chat.domain.ports.transcript_storage import TranscriptStorage


@dataclass(frozen=True, slots=True)
class AppDeps:
    settings: Settings
    pool: asyncpg.Pool
    embedder: EmbedderPort
    chunk_repo: ChunkRepository
    catalog_repo: CatalogRepository
    transcript_storage: TranscriptStorage
    outline_cache: OutlineCache
    rate_limiter: RateLimiter


def get_deps(request: Request) -> AppDeps:
    """FastAPI dependency: read the AppDeps stashed in `app.state` by
    the lifespan handler. Raises if lifespan hasn't run yet."""
    deps = getattr(request.app.state, "deps", None)
    if deps is None:
        raise RuntimeError(
            "AppDeps missing on app.state — lifespan not initialised"
        )
    return deps
