"""Healthz / readyz / version / status / reindex."""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from shruti_chat.config import get_settings
from shruti_chat.db.client import get_pool
from shruti_chat.indexer import run as indexer_run
from shruti_chat.indexer.embed import get_embedder

router = APIRouter()

_started_at = time.monotonic()

# Build stamps — set by the image build (Dockerfile ARG → ENV). Empty
# in local-dev. Operators hit /healthz post-deploy to confirm
# Watchtower rolled the new image.
_BUILD_SHA = os.environ.get("SHRUTI_BUILD_SHA", "")
_BUILD_TIME = os.environ.get("SHRUTI_BUILD_TIME", "")


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
            "GET /readyz": "readiness (db + embedder + catalog)",
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
async def readyz() -> ReadyResponse:
    s = get_settings()
    checks = {
        "db": False,
        "embedder": False,
        "catalog": False,
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
    # Schedule on background loop without blocking response.
    task = asyncio.create_task(
        indexer_run.run_once(
            trigger="manual",
            track_ids_filter=body.track_ids,
            lang_filter=body.lang,
            force_catalog=body.force_catalog,
        )
    )
    # Attach a no-op done callback so errors are at least logged
    task.add_done_callback(lambda t: t.exception() if t.exception() else None)
    return {"accepted": True, "started_at": datetime.now(timezone.utc).isoformat()}
