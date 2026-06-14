"""FastAPI HTTP layer. Mirrors transcriber-service's REST surface:

  POST   /jobs            queue a denoise job (JSON body)
  GET    /jobs            list jobs (?status=&limit=)
  GET    /jobs/{id}       job metadata
  DELETE /jobs/{id}       remove a finished/failed job
  GET    /healthz         counts + readiness
"""
from __future__ import annotations

import os
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .models import (
    CreateJobRequest, CreateJobResponse, HealthResponse, Job, Status,
)
from .store import Store
from .worker import Worker


def create_app(store: Store, worker: Worker, *, workers: int, started_at: float) -> FastAPI:
    app = FastAPI(title="denoiser-service", version="0.1.0")

    @app.get("/healthz", response_model=HealthResponse)
    def healthz() -> HealthResponse:
        c = store.counts()
        return HealthResponse(
            workers=workers,
            queued=c["queued"], running=c["running"], done=c["done"], failed=c["failed"],
            denoiser_ready=worker.ready(),
            uptime_s=int(time.time() - started_at),
        )

    @app.post("/jobs", response_model=CreateJobResponse, status_code=201)
    def create_job(req: CreateJobRequest) -> CreateJobResponse:
        if not worker.ready():
            raise HTTPException(503, "denoiser not ready (script/deps unavailable)")
        job_id = uuid.uuid4().hex
        filename = req.filename or os.path.basename(req.source_url.split("?", 1)[0]) or job_id
        j = Job(
            job_id=job_id,
            filename=filename,
            source_url=req.source_url,
            dest_bucket=req.dest.bucket,
            dest_key=req.dest.key,
            status=Status.QUEUED,
            uploaded_at=int(time.time() * 1000),
        )
        store.insert(j)
        worker.submit(job_id, req.dest, req.params)
        return CreateJobResponse(job_id=job_id, status=Status.QUEUED, filename=filename)

    @app.get("/jobs")
    def list_jobs(status: str = "", limit: int = 200) -> JSONResponse:
        jobs = store.list(status=status, limit=limit)
        return JSONResponse([j.to_dict() for j in jobs])

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str) -> JSONResponse:
        j = store.get(job_id)
        if j is None:
            raise HTTPException(404, "job not found")
        return JSONResponse(j.to_dict())

    @app.delete("/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str) -> JSONResponse:
        j = store.get(job_id)
        if j is None:
            raise HTTPException(404, "job not found")
        if j.status == Status.RUNNING:
            raise HTTPException(409, "cannot delete a running job")
        store.delete(job_id)
        return JSONResponse(status_code=204, content=None)

    return app
