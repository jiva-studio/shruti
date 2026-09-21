"""Composition root — assembles `AppDeps` from settings + concrete adapters.

`AppDeps` is the only place infrastructure objects live as long-lived
references; FastAPI routes pull them via `Depends(get_deps)`. Replacing
an adapter (e.g. for tests) means building an `AppDeps` instance with
fake repos and stuffing it into `app.state.deps`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Request

from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.application.turn_runner import TurnRunner
from shruti_chat.config import Settings
from shruti_chat.infra.auth.jwt_verifier import JwtVerifier
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort
from shruti_chat.domain.ports.kv_cache import KVCache
from shruti_chat.domain.ports.library_repository import LibraryRepository
from shruti_chat.domain.ports.llm_provider import LLMPort
from shruti_chat.domain.ports.idempotency_store import IdempotencyStore
from shruti_chat.domain.ports.turn_store import TurnStore
from shruti_chat.domain.ports.reranker import RerankerPort
from shruti_chat.domain.ports.translation import TranslationService


from shruti_chat.application.deps import AppDeps


def get_deps(request: Request) -> AppDeps:
    """FastAPI dependency: read the AppDeps stashed in `app.state` by
    the lifespan handler. Raises if lifespan hasn't run yet."""
    deps = getattr(request.app.state, "deps", None)
    if deps is None:
        raise RuntimeError(
            "AppDeps missing on app.state — lifespan not initialised"
        )
    return deps
