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
from prometheus_client import make_asgi_app
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from lectorium_chat.agent import llm
from lectorium_chat.agent.tools import bind_repositories
from lectorium_chat.api import admin, chat, feedback, questions, title
from lectorium_chat.application.rate_limiter import RateLimiter
from lectorium_chat.composition import AppDeps
from lectorium_chat.config import get_settings
from lectorium_chat.infra.llm_provider import build_llm_provider
from lectorium_chat.db.client import close_pool, init_pool
from lectorium_chat.db.assert_schema import assert_schema_ready
from lectorium_chat.indexer import run as indexer_run
from lectorium_chat.indexer.embed import get_embedder
from lectorium_chat.infra.rerank import get_reranker
from lectorium_chat.infra.rate_limit.redis_rate_limit_store import RedisRateLimitStore
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import PgChunkRepository
from lectorium_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)
from lectorium_chat.infra.cache import versions as cache_versions
from lectorium_chat.infra.cache.cached_embedder import CachedEmbedder
from lectorium_chat.infra.cache.memory_kv_cache import MemoryKVCache
from lectorium_chat.infra.cache.redis_kv_cache import RedisKVCache
from lectorium_chat.infra.cache.tiered_kv_cache import TieredKVCache
from lectorium_chat.infra.auth.jwt_verifier import JwtVerifier
from lectorium_chat.infra.storage.s3_outline_cache import S3OutlineCache
from lectorium_chat.infra.storage.s3_transcript_storage import S3TranscriptStorage
from lectorium_chat.observability.bootstrap import bootstrap_score_configs
from lectorium_chat.observability.langfuse_client import (
    LANGFUSE_PROMPT_NAMES,
    get_langfuse,
    init_langfuse,
    shutdown_langfuse,
    warm_prompt_cache,
    warn_if_pii_salt_unset,
)
from lectorium_chat.observability.logging import get_logger, setup_logging


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
    # In prod/staging, log a critical warning when the PII salt is
    # missing — otherwise RU-region traces silently drop their user_id
    # and operators may not notice until per-user breakdowns disappear.
    warn_if_pii_salt_unset()
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
    # Per-dim embedding router (migration 0030 split embeddings into
    # `chunk_embeddings_d{N}` / `attribution_emb_d{N}` tables, one per
    # supported `EMBED_DIM`). Fails fast on a misconfigured dim so a
    # mistyped env can't silently route writes into a missing table.
    embedding_router = EmbeddingTableRouter(dim=s.embed_dim)
    chunk_repo = PgChunkRepository(
        pool=pool,
        embed_model=embedder.name,
        router=embedding_router,
        kv_cache=(kv_cache if s.cache_enabled else None),
    )
    catalog_repo = SqliteCatalogRepository(catalog_db_path=s.catalog_db_path)
    transcript_storage = S3TranscriptStorage(settings=s)
    outline_cache = S3OutlineCache(settings=s)
    if not s.redis_url:
        raise RuntimeError("REDIS_URL is required for the rate-limit store")
    rate_limit_store = RedisRateLimitStore(s.redis_url)
    rate_limiter = RateLimiter(store=rate_limit_store, settings=s)
    jwt_verifier = JwtVerifier.from_file(s.jwt_public_key_path)

    # Idempotency gate for /chat. Redis-backed when configured;
    # otherwise no-op so dev deploys without Redis don't break.
    if s.redis_url:
        from lectorium_chat.infra.idempotency.redis_idempotency_store import (
            RedisIdempotencyStore,
        )
        idempotency_store = RedisIdempotencyStore(s.redis_url)
    else:
        from lectorium_chat.infra.idempotency.noop import NoopIdempotencyStore
        idempotency_store = NoopIdempotencyStore()

    # Turn buffer for the resume / reconnect flow. Redis-backed when
    # configured; no-op otherwise (resume simply off).
    if s.redis_url:
        from lectorium_chat.infra.turn_store.redis_turn_store import RedisTurnStore
        turn_store = RedisTurnStore(s.redis_url)
    else:
        from lectorium_chat.infra.turn_store.noop import NoopTurnStore
        turn_store = NoopTurnStore()

    # Hosts chat turns as detached background tasks (buffer + resume + cancel).
    from lectorium_chat.application.turn_runner import TurnRunner
    turn_runner = TurnRunner(turn_store)

    # LangGraph wiring. Compile the chat graph once and stash on deps —
    # node fns are async and stateless, the compiled graph is reused
    # for every chat turn.
    from lectorium_chat.agent.graph import build_chat_graph

    llm_provider = build_llm_provider(s)
    chat_graph = build_chat_graph()

    # Citation translator (opt-in `translate_citations`). Persistent PG
    # cache + Redis hot tier in front of the LLM. Built unconditionally;
    # the per-turn flag gates whether it actually runs.
    from lectorium_chat.infra.translation.llm_translator import LlmTranslationService
    from lectorium_chat.infra.translation.pg_translation_cache import PgTranslationCache

    translation_service = LlmTranslationService(
        llm=llm_provider,
        model=s.llm_translate,
        pg_cache=PgTranslationCache(pool=pool),
        kv_cache=(kv_cache if s.cache_enabled else None),
    )

    app.state.deps = AppDeps(
        settings=s,
        pool=pool,
        embedder=embedder,
        chunk_repo=chunk_repo,
        catalog_repo=catalog_repo,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
        rate_limiter=rate_limiter,
        jwt_verifier=jwt_verifier,
        kv_cache=kv_cache,
        idempotency_store=idempotency_store,
        turn_store=turn_store,
        turn_runner=turn_runner,
        llm=llm_provider,
        chat_graph=chat_graph,
        reranker=get_reranker(s),
        translation_service=translation_service,
    )

    # Wire the registered tool callables with their concrete adapters.
    bind_repositories(
        chunk_repo=chunk_repo,
        catalog_repo=catalog_repo,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
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
        # Cancel any in-flight detached chat-turn producers so the redeploy
        # terminates cleanly instead of abandoning tasks mid-run.
        await turn_runner.shutdown()
        if l2 is not None:
            await l2.close()
        await rate_limit_store.close()
        await close_pool()
        # Flush pending Langfuse traces last — close() above doesn't
        # block on the SDK's background flusher; if we exit before it
        # drains, ~1-2 seconds of traces are dropped on every redeploy.
        shutdown_langfuse()


app = FastAPI(
    title="Lectorium chat",
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
        # SSE v1 handshake — client MUST send `X-Chat-Protocol-Version: 1`
        # on every /chat call (see api/chat.py:_check_protocol_version).
        # Without it on this list, the CORS preflight rejects with 400
        # and the actual POST never fires.
        "X-Chat-Protocol-Version",
        # Client-generated request id for retry dedup (Etap 4.4). Without
        # this in the allow-list, every browser preflight fails — the
        # actual POST never lands.
        "Idempotency-Key",
        # Client-minted Langfuse trace id (hyphenless 32-hex form of
        # the assistant ChatMessage.id). Same allowlist constraint:
        # Capacitor WebView issues a CORS preflight on any non-simple
        # header, and a missing entry here means the actual POST never
        # fires — the mobile UI shows "connection lost".
        "X-Trace-Id",
    ],
    expose_headers=["Retry-After"],
    max_age=86400,
)

# X-Forwarded-For trust. Caddy sits in front of us on the docker bridge
# network and always sets XFF; without this middleware every request
# would log/rate-limit against the proxy's bridge IP instead of the real
# client IP, collapsing the per-IP defence into one shared bucket. The
# trusted CIDR list is locked to RFC1918 docker ranges by default, so an
# attacker who reaches the service from outside the cluster can't spoof
# their source by injecting the header directly. Added LAST so it wraps
# CORS and is the OUTERMOST middleware — by the time CORS / route
# handlers / structlog `bind_contextvars(ip=...)` read `request.client`,
# the rewrite has already happened.
app.add_middleware(
    ProxyHeadersMiddleware,
    trusted_hosts=get_settings().trusted_proxy_cidrs,
)

app.include_router(chat.router)
app.include_router(admin.router)
app.include_router(title.router)
app.include_router(questions.router)
app.include_router(feedback.router)

# Prometheus scrape target. Mounted as a sub-app so it sits outside the
# CORS / proxy-headers middleware (internal scrape, no browser origin)
# and serves the default REGISTRY the counters in `observability.metrics`
# register into. `metrics` is already imported transitively via
# `application.rate_limiter`; importing it here too makes the dependency
# explicit and import-order-independent.
from lectorium_chat.observability import metrics as _metrics  # noqa: F401,E402

app.mount("/metrics", make_asgi_app())
