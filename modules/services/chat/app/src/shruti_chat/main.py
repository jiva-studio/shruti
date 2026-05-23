"""FastAPI application entrypoint.

Lifespan:
1. setup_logging                       (so all subsequent logs are JSON)
2. init Postgres pool + apply schema
3. configure LLM providers
4. load embedder
5. build AppDeps (composition root) → bind into agent tools
6. bootstrap catalog (synchronous) → /readyz can go green
7. start indexer scheduler task (background)
8. accept traffic
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from shruti_chat.agent import llm
from shruti_chat.agent.tools import bind_repositories
from shruti_chat.api import admin, chat, feedback, questions, title
from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.composition import AppDeps
from shruti_chat.config import get_settings
from shruti_chat.db.client import close_pool, init_pool
from shruti_chat.db.assert_schema import assert_schema_ready
from shruti_chat.indexer import run as indexer_run
from shruti_chat.indexer.embed import get_embedder
from shruti_chat.infra.rate_limit.pg_rate_limit_store import PgRateLimitStore
from shruti_chat.infra.repositories.pg_chunk_repository import PgChunkRepository
from shruti_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)
from shruti_chat.infra.cache import versions as cache_versions
from shruti_chat.infra.cache.cached_embedder import CachedEmbedder
from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache
from shruti_chat.infra.cache.redis_kv_cache import RedisKVCache
from shruti_chat.infra.cache.tiered_kv_cache import TieredKVCache
from shruti_chat.infra.auth.jwt_verifier import JwtVerifier
from shruti_chat.infra.pdf import register_fonts
from shruti_chat.infra.storage.s3_outline_cache import S3OutlineCache
from shruti_chat.infra.storage.s3_pdf_storage import S3PdfStorage
from shruti_chat.infra.storage.s3_transcript_storage import S3TranscriptStorage
from shruti_chat.observability.bootstrap import bootstrap_score_configs
from shruti_chat.observability.langfuse_client import (
    LANGFUSE_PROMPT_NAMES,
    get_langfuse,
    init_langfuse,
    shutdown_langfuse,
    warm_prompt_cache,
)
from shruti_chat.observability.logging import get_logger, setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log = get_logger(__name__)
    s = get_settings()
    started = time.monotonic()
    log.info("service_starting", version=s.service_version)

    # Langfuse SDK (LLM observability + prompt hot-reload). Initialises
    # the process-wide singleton from env vars; no-op when
    # LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY are unset OR
    # LANGFUSE_FORCE_FALLBACK=1 (eval / local dev). Warm the prompt
    # cache so the first chat-turn doesn't pay the network round-trip
    # to fetch each of the 15 prompts on the hot path.
    init_langfuse()
    warm_prompt_cache(list(LANGFUSE_PROMPT_NAMES))
    # Register every score config declared in `score_configs.py`. Self-
    # heals a wiped Langfuse DB; idempotent on every other boot. Non-
    # fatal — if it fails the service still serves traffic, scores just
    # ingest without UI-side validation.
    bootstrap_score_configs(get_langfuse())

    pool = await init_pool(s)
    await assert_schema_ready()
    llm.configure_providers(s)
    embedder = get_embedder(s)

    # PDF export uses bundled TTFs — register once at startup so the
    # first request doesn't pay the cost on the hot path.
    register_fonts()

    # KV cache — L1 (in-proc LRU+TTL) always; L2 (Redis, AOF-persistent)
    # when REDIS_URL is configured. Either tier degrades gracefully:
    # L2 circuit-opens on repeated failure and L1 keeps serving; L1
    # caps each entry at min(L2_TTL, 60s) so a version bump propagates
    # within a minute even without an explicit flush.
    l1 = MemoryKVCache(max_entries=10000)
    l2: RedisKVCache | None = None
    if s.cache_enabled and s.redis_url:
        l2 = RedisKVCache(s.redis_url)
    kv_cache = TieredKVCache(l1, l2)

    # Seed version segments. `embed_model` is derived from settings now;
    # `catalog` / `library` come from `db_state` once the schema is in
    # place. The indexer hooks bump these on every swap from this point.
    cache_versions.initialize_from_settings(s)
    await cache_versions.refresh_from_db(pool)

    # Wrap the embedder so single-query embeddings get memoised by
    # (text, model). embed_documents stays uncached at this layer (see
    # CachedEmbedder docstring). When cache_enabled=false the raw
    # embedder is used so A/B comparisons stay clean.
    if s.cache_enabled:
        embedder = CachedEmbedder(embedder, kv_cache)

    # Build the composition: each adapter takes only the dependencies
    # it needs, the use-cases take ports.
    chunk_repo = PgChunkRepository(
        pool=pool,
        embed_model=embedder.name,
        kv_cache=(kv_cache if s.cache_enabled else None),
    )
    catalog_repo = SqliteCatalogRepository(catalog_db_path=s.catalog_db_path)
    transcript_storage = S3TranscriptStorage(settings=s)
    outline_cache = S3OutlineCache(settings=s)
    pdf_storage = S3PdfStorage(settings=s)
    rate_limiter = RateLimiter(
        store=PgRateLimitStore(pool=pool), settings=s,
    )
    jwt_verifier = JwtVerifier(public_key_path=s.jwt_public_key_path)

    # LangGraph wiring. Compile the chat graph once and stash on deps —
    # node fns are async and stateless, the compiled graph is reused
    # for every chat turn.
    from shruti_chat.agent.graph import build_chat_graph
    from shruti_chat.infra.llm_provider import OpenRouterLLMProvider

    llm_provider = OpenRouterLLMProvider(s)
    chat_graph = build_chat_graph()

    app.state.deps = AppDeps(
        settings=s,
        pool=pool,
        embedder=embedder,
        chunk_repo=chunk_repo,
        catalog_repo=catalog_repo,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
        pdf_storage=pdf_storage,
        rate_limiter=rate_limiter,
        jwt_verifier=jwt_verifier,
        kv_cache=kv_cache,
        llm=llm_provider,
        chat_graph=chat_graph,
    )

    # Wire the registered tool callables with their concrete adapters.
    bind_repositories(
        chunk_repo=chunk_repo,
        catalog_repo=catalog_repo,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
        pdf_storage=pdf_storage,
        embedder=embedder,
    )

    if s.indexer_bootstrap_on_start:
        try:
            await indexer_run.bootstrap_catalog(s)
        except Exception as exc:
            log.exception("catalog_bootstrap_failed", error=str(exc))
            # We continue; /readyz will show catalog=false until next scheduled run.

    stop_event = asyncio.Event()
    scheduler_task = asyncio.create_task(
        indexer_run.scheduler_loop(s, stop_event=stop_event),
        name="indexer_scheduler",
    )

    log.info(
        "service_ready",
        ms_to_ready=int((time.monotonic() - started) * 1000),
        port=s.port,
    )
    try:
        yield
    finally:
        log.info("service_stopping")
        stop_event.set()
        scheduler_task.cancel()
        try:
            await scheduler_task
        except (asyncio.CancelledError, Exception):
            pass
        if l2 is not None:
            await l2.close()
        await close_pool()
        # Flush pending Langfuse traces last — close() above doesn't
        # block on the SDK's background flusher; if we exit before it
        # drains, ~1-2 seconds of traces are dropped on every redeploy.
        shutdown_langfuse()


app = FastAPI(
    title="Shruti chat",
    lifespan=lifespan,
)

# CORS — mobile app talks to us cross-origin (Capacitor wraps webview as
# `capacitor://localhost`, `ionic://localhost`, `http://localhost:8100` in
# dev). Allow-list comes from `CORS_ALLOW_ORIGINS` (comma-separated).
# Default `*` keeps dev frictionless; prod env should pin to the real
# app origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Accept",
        # JWT for user identity + per-user rate-limit keying. Replaces
        # the legacy X-Device-Id header.
        "Authorization",
        "X-App-Token",
        # SSE v1 handshake — client MUST send `X-Chat-Protocol-Version: 1`
        # on every /chat call (see api/chat.py:_check_protocol_version).
        # Without it on this list, the CORS preflight rejects with 400
        # and the actual POST never fires.
        "X-Chat-Protocol-Version",
        # Client-generated request id for retry dedup (Etap 4.4). Without
        # this in the allow-list, every browser preflight fails — the
        # actual POST never lands.
        "Idempotency-Key",
    ],
    expose_headers=["Retry-After"],
    max_age=86400,
)

app.include_router(chat.router)
app.include_router(admin.router)
app.include_router(title.router)
app.include_router(questions.router)
app.include_router(feedback.router)
