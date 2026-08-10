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


@dataclass(frozen=True, slots=True)
class AppDeps:
    settings: Settings
    embedder: EmbedderPort
    chunk_repo: ChunkRepository
    catalog_repo: CatalogRepository
    rate_limiter: RateLimiter
    jwt_verifier: JwtVerifier
    kv_cache: KVCache
    # Atomic duplicate-request gate keyed on Idempotency-Key. Implemented
    # over Redis when configured, no-op otherwise.
    idempotency_store: IdempotencyStore
    # Buffers a turn's SSE events so a client that dropped the connection
    # (backgrounded / navigated away) can fetch the finished answer on
    # return. Redis when configured, no-op (resume off) otherwise.
    turn_store: TurnStore
    # Hosts a chat turn as a detached background task (spawn / buffer /
    # heartbeat / cancel registry) so that lifecycle stays out of the API route.
    turn_runner: TurnRunner
    # LangGraph wiring. `llm` is the injected LLMPort (OpenRouter adapter
    # in production, FakeLLM in tests). `chat_graph` is the compiled
    # Pregel — built once at startup, reused for every chat turn.
    llm: LLMPort
    chat_graph: Any  # langgraph.pregel.Pregel — kept as Any to avoid import here
    # Cross-encoder reranker. None when no provider is configured / the
    # API key is missing → the research pipeline degrades to cosine.
    # Reads of the published library.db snapshot (verse bodies, purports,
    # chapter titles, document bodies, media rows). Optional so a test can
    # build deps without a snapshot on disk — a turn degrades to chips.
    library_repo: LibraryRepository | None = None
    reranker: RerankerPort | None = None
    # Citation translator (opt-in `translate_citations`). Always built —
    # the per-turn flag, not its presence, gates whether it runs.
    translation_service: TranslationService | None = None
    # Add-to-library (#1226). Multi-provider external-lecture search resolver
    # the multi-provider external-lecture search resolver. Always built (a
    # keyless deploy gets inert providers), so the add_to_library_worker can
    # always read it off the deps. Chat never ingests — the client submits the
    # chosen candidate URL to the orchestrator ingest API.
    lecture_search: Any | None = None


def get_deps(request: Request) -> AppDeps:
    """FastAPI dependency: read the AppDeps stashed in `app.state` by
    the lifespan handler. Raises if lifespan hasn't run yet."""
    deps = getattr(request.app.state, "deps", None)
    if deps is None:
        raise RuntimeError(
            "AppDeps missing on app.state — lifespan not initialised"
        )
    return deps
