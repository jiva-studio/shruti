"""FastAPI application entrypoint.

Lifespan:
1. setup_logging                       (so all subsequent logs are JSON)
2. init Postgres pool + apply schema
3. configure LLM providers
4. load BGE-M3 (heavy: ~15-30s)
5. bootstrap catalog (synchronous) → /readyz can go green
6. start indexer scheduler task (background)
7. accept traffic
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from shruti_chat.agent import llm
from shruti_chat.api import admin, chat, title
from shruti_chat.config import get_settings
from shruti_chat.db.client import close_pool, init_pool
from shruti_chat.db.migrate import apply_schema
from shruti_chat.indexer import run as indexer_run
from shruti_chat.indexer.embed import get_embedder
from shruti_chat.observability.logging import get_logger, setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log = get_logger(__name__)
    s = get_settings()
    started = time.monotonic()
    log.info("service_starting", version=s.service_version)

    await init_pool(s)
    await apply_schema()
    llm.configure_providers(s)
    # Load embedder synchronously — heavy but only once.
    get_embedder(s)

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
    allow_headers=["Content-Type", "Accept", "X-Device-Id", "X-App-Token"],
    expose_headers=["Retry-After"],
    max_age=86400,
)

app.include_router(chat.router)
app.include_router(admin.router)
app.include_router(title.router)
