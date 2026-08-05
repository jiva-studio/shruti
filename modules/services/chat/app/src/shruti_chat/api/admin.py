"""Healthz / readyz / version / status / reindex."""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from shruti_chat.config import get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer import run as indexer_run
from shruti_chat.agent.prompts.registry import LANGFUSE_PROMPT_NAMES
from shruti_chat.indexer.embed import get_embedder
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.metrics import prompt_source_summary

router = APIRouter()

log = get_logger(__name__)

# In-flight manual reindex, if any. Held rather than discarded for two
# reasons: a second POST can see a run is already going, and `create_task`
# keeps only a weak reference — a local variable let the task be collected
# mid-run.
#
# This guards the MANUAL trigger only. The scheduler loop and the
# `track.ready` consumer can still start a run alongside it; making the
# triggers mutually exclusive belongs in the indexer, and doing it across
# replicas needs a Postgres advisory lock.
_reindex_task: asyncio.Task[str] | None = None


def _log_reindex_result(task: asyncio.Task[str]) -> None:
    """Surface how a detached reindex ended. The previous callback called
    `task.exception()` and threw the result away, so a failed run left no
    trace beyond whatever the indexer logged on its way down."""
    if task.cancelled():
        log.warning("reindex_cancelled")
        return
    exc = task.exception()
    if exc is not None:
        log.error("reindex_failed", error=str(exc))
    else:
        log.info("reindex_finished", run_id=task.result())

_started_at = time.monotonic()

# Build stamps — set by the image build (Dockerfile ARG → ENV). Empty
# in local-dev. Operators hit /healthz post-deploy to confirm
# Watchtower rolled the new image.
_BUILD_SHA = get_settings().shruti_build_sha
_BUILD_TIME = get_settings().shruti_build_time


def _check_token(token: str | None) -> None:
    if not token or token != get_settings().app_shared_token:
        raise HTTPException(status_code=401, detail="invalid app token")


@router.get("/")
async def root() -> dict[str, Any]:
    """Public banner — list available endpoints. Replaces the bare 404."""
    return {
        "service": "shruti-chat",
        "version": get_settings().service_version,
        "endpoints": {
            "POST /chat": "SSE stream of agent response "
                          "(requires Authorization: Bearer <jwt>)",
            "POST /title": "one-shot session title from a short history "
                           "(requires Authorization: Bearer <jwt>)",
            "POST /questions": "3-4 suggested questions for a focus fragment "
                               "(requires Authorization: Bearer <jwt>)",
            "POST /reindex": "force indexer run (admin, requires X-App-Token)",
            "GET /healthz": "liveness",
            "GET /readyz": "readiness (db + embedder + catalog + redis)",
            "GET /status": "detailed runtime status (admin, requires X-App-Token)",
            "GET /version": "build info",
        },
    }


@router.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "build": {"sha": _BUILD_SHA, "time": _BUILD_TIME},
    }


class ReadyResponse(BaseModel):
    ready: bool
    checks: dict[str, bool]


@router.get("/readyz", response_model=ReadyResponse)
async def readyz(request: Request) -> ReadyResponse:
    s = get_settings()
    checks = {
        "db": False,
        "embedder": False,
        "catalog": False,
        "redis": False,
    }
    # DB
    try:
        async with get_pool().acquire() as conn:
            await conn.execute("SELECT 1")
        checks["db"] = True
    except Exception:
        pass
    # Catalog
    try:
        if s.catalog_db_path.exists():
            async with get_pool().acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT current_version FROM db_state WHERE kind = 'catalog'")
                checks["catalog"] = bool(row and row["current_version"])
    except Exception:
        pass
    # Embedder
    try:
        get_embedder()  # cached; raises if not init'd
        checks["embedder"] = True
    except Exception:
        pass
    # Redis — mandatory for the rate-limit store in prod (main.py refuses
    # to boot without REDIS_URL). Without this gate a pod with a wedged
    # Redis reports ready and then 503s every free/anon chat. Probed via
    # the rate-limiter so admin.py doesn't reach into the infra adapter.
    try:
        deps = getattr(request.app.state, "deps", None)
        checks["redis"] = bool(deps and await deps.rate_limiter.store_healthy())
    except Exception:
        pass

    ready = all(checks.values())
    if not ready:
        raise HTTPException(status_code=503, detail={"ready": False, "checks": checks})
    return ReadyResponse(ready=True, checks=checks)


@router.get("/version")
async def version() -> dict[str, Any]:
    s = get_settings()
    return {"git_sha": s.service_version, "service": "shruti-chat"}


@router.get("/status")
async def status(x_app_token: str | None = Header(default=None)) -> dict[str, Any]:
    _check_token(x_app_token)
    s = get_settings()
    pool = get_pool()
    async with pool.acquire() as conn:
        # catalog version
        cs = await conn.fetchrow(
            "SELECT current_version, updated_at FROM db_state WHERE kind='catalog'")
        # vectors
        v_total = await conn.fetchval("SELECT COUNT(*) FROM chunks")
        v_models = await conn.fetch(
            "SELECT embed_model, COUNT(*) AS n FROM chunks GROUP BY embed_model")
        v_by_lang = await conn.fetch(
            "SELECT lang, COUNT(*) AS n FROM chunks GROUP BY lang")
        # indexer
        runs = await conn.fetch(
            """
            SELECT run_id, state, started_at, finished_at, tracks_done,
                   chunks_total, trigger, error
            FROM indexer_runs
            ORDER BY started_at DESC
            LIMIT 10
            """
        )

    return {
        "service": "shruti-chat",
        "version": s.service_version,
        "uptime_s": int(time.monotonic() - _started_at),
        "ready": s.catalog_db_path.exists() and bool(cs and cs["current_version"]),
        "catalog": {
            "version": cs["current_version"] if cs else None,
            "swapped_at": cs["updated_at"].isoformat() if cs and cs["updated_at"] else None,
        },
        "vectors": {
            "chunks_total": v_total or 0,
            "by_lang": {r["lang"]: r["n"] for r in v_by_lang},
            "by_model": {r["embed_model"]: r["n"] for r in v_models},
        },
        # Where prompts are coming from. A non-empty `serving_from_fallback`
        # means Langfuse is unreachable (or force-disabled) and those prompts
        # are the copy baked into the image — which `pull` only refreshes by
        # hand, so it can be arbitrarily far behind the live text.
        # Non-empty means development defaults are live. On a prod deploy that
        # lost `ENV` the boot guard never fires, so this is where it shows.
        "insecure_defaults": s.insecure_defaults(),
        "prompts": {
            "registered": len(LANGFUSE_PROMPT_NAMES),
            **prompt_source_summary(),
        },
        "indexer": {
            "last_runs": [
                {
                    "run_id": r["run_id"],
                    "state": r["state"],
                    "started_at": r["started_at"].isoformat() if r["started_at"] else None,
                    "finished_at": r["finished_at"].isoformat() if r["finished_at"] else None,
                    "tracks_done": r["tracks_done"],
                    "chunks_total": r["chunks_total"],
                    "trigger": r["trigger"],
                    "error": r["error"],
                } for r in runs
            ],
            "interval_hours": s.indexer_interval_hours,
        },
    }


class ReindexRequest(BaseModel):
    force_catalog: bool = False
    track_ids: list[str] | None = None
    lang: str | None = None


@router.post("/reindex", status_code=202)
async def reindex(
    body: ReindexRequest | None = None,
    x_app_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_token(x_app_token)
    body = body or ReindexRequest()
    global _reindex_task
    # Single-flight. Without this, N POSTs spawned N full runs, each opening
    # 8 concurrent transcript workers against the shared pool and paying for
    # its own embeddings; they also raced the unscoped GC deletes.
    if _reindex_task is not None and not _reindex_task.done():
        raise HTTPException(status_code=409, detail="reindex already running")
    # Schedule on background loop without blocking response.
    _reindex_task = asyncio.create_task(
        indexer_run.run_once(
            trigger="manual",
            track_ids_filter=body.track_ids,
            lang_filter=body.lang,
            force_catalog=body.force_catalog,
        )
    )
    _reindex_task.add_done_callback(_log_reindex_result)
    return {"accepted": True, "started_at": datetime.now(timezone.utc).isoformat()}
