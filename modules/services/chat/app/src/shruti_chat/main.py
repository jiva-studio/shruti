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
from shruti_chat.api import admin, chat, title
from shruti_chat.application.rate_limiter import RateLimiter
from shruti_chat.composition import AppDeps
from shruti_chat.config import get_settings
from shruti_chat.db.client import close_pool, init_pool
from shruti_chat.db.migrate import apply_schema
from shruti_chat.indexer import run as indexer_run
from shruti_chat.indexer.embed import get_embedder
from shruti_chat.infra.rate_limit.pg_rate_limit_store import PgRateLimitStore
from shruti_chat.infra.repositories.pg_chunk_repository import PgChunkRepository
from shruti_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)
from shruti_chat.infra.storage.s3_outline_cache import S3OutlineCache
from shruti_chat.infra.storage.s3_transcript_storage import S3TranscriptStorage
from shruti_chat.observability.logging import get_logger, setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log = get_logger(__name__)
    s = get_settings()
    started = time.monotonic()
    log.info("service_starting", version=s.service_version)

    pool = await init_pool(s)
    await apply_schema()
    llm.configure_providers(s)
    embedder = get_embedder(s)

    # Build the composition: each adapter takes only the dependencies
    # it needs, the use-cases take ports.
    chunk_repo = PgChunkRepository(pool=pool, embed_model=embedder.name)
    catalog_repo = SqliteCatalogRepository(catalog_db_path=s.catalog_db_path)
    transcript_storage = S3TranscriptStorage(settings=s)
    outline_cache = S3OutlineCache(settings=s)
    rate_limiter = RateLimiter(
        store=PgRateLimitStore(pool=pool), settings=s,
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
        await close_pool()


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
        "X-Device-Id",
        "X-App-Token",
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
