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

from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.config import Settings
from lectorium_chat.infra.auth.jwt_verifier import JwtVerifier
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort
from lectorium_chat.domain.ports.kv_cache import KVCache
from lectorium_chat.domain.ports.library_repository import LibraryRepository
from lectorium_chat.domain.ports.llm_provider import LLMPort
from lectorium_chat.domain.ports.idempotency_store import IdempotencyStore
from lectorium_chat.domain.ports.turn_store import TurnStore
from lectorium_chat.domain.ports.reranker import RerankerPort
from lectorium_chat.domain.ports.translation import TranslationService


from lectorium_chat.application.deps import AppDeps


def get_deps(request: Request) -> AppDeps:
    """FastAPI dependency: read the AppDeps stashed in `app.state` by
    the lifespan handler. Raises if lifespan hasn't run yet."""
    deps = getattr(request.app.state, "deps", None)
    if deps is None:
        raise RuntimeError(
            "AppDeps missing on app.state — lifespan not initialised"
        )
    return deps
