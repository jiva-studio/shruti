"""Application dependency container (AppDeps).

DTO holding references to domain ports and application services.
Kept in `application` layer to prevent circular dependencies with composition root.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort
from lectorium_chat.domain.ports.idempotency_store import IdempotencyStore
from lectorium_chat.domain.ports.jwt_verifier import JwtVerifierPort
from lectorium_chat.domain.ports.kv_cache import KVCache
from lectorium_chat.domain.ports.library_repository import LibraryRepository
from lectorium_chat.domain.ports.llm_provider import LLMPort
from lectorium_chat.domain.ports.reranker import RerankerPort
from lectorium_chat.domain.ports.translation import TranslationService
from lectorium_chat.domain.ports.turn_store import TurnStore


@dataclass(frozen=True, slots=True)
class AppDeps:
    settings: Settings
    embedder: EmbedderPort
    chunk_repo: ChunkRepository
    catalog_repo: CatalogRepository
    rate_limiter: RateLimiter
    jwt_verifier: JwtVerifierPort
    kv_cache: KVCache
    idempotency_store: IdempotencyStore
    turn_store: TurnStore
    turn_runner: TurnRunner
    llm: LLMPort
    chat_graph: Any
    reranker: RerankerPort | None = None
    library_repo: LibraryRepository | None = None
    translation_service: TranslationService | None = None
    lecture_search: Any | None = None
