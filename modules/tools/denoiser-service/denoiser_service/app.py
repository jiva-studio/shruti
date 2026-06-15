"""FastAPI HTTP layer. Mirrors transcriber-service's REST surface:

  POST   /jobs            queue a denoise job (JSON body)
  GET    /jobs            list jobs (?status=&limit=)
  GET    /jobs/{id}       job metadata
  DELETE /jobs/{id}       remove a finished/failed job
  GET    /healthz         counts + readiness
"""
from __future__ import annotations

import os
import posixpath
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from . import s3util
from .models import (
    BatchRequest, BatchResponse, CreateJobRequest, CreateJobResponse,
    HealthResponse, Job, ListObjectsRequest, ListObjectsResponse, S3Dest, Status,
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

    @app.post("/source/list", response_model=ListObjectsResponse)
    def list_source(req: ListObjectsRequest) -> ListObjectsResponse:
        try:
            objs = s3util.list_objects(req.source, limit=req.limit)
        except Exception as e:  # noqa: BLE001 — surface S3 errors to the client
            raise HTTPException(502, f"list objects failed: {e}") from e
        return ListObjectsResponse(count=len(objs), objects=objs)

    @app.post("/jobs/batch", response_model=BatchResponse, status_code=201)
    def create_batch(req: BatchRequest) -> BatchResponse:
        if not worker.ready():
            raise HTTPException(503, "denoiser not ready (script/deps unavailable)")
        if bool(req.items) == bool(req.source):
            raise HTTPException(400, "provide exactly one of 'items' or 'source'")

        now = int(time.time() * 1000)
        jobs: list[Job] = []
        contexts: list[tuple[str, S3Dest]] = []  # (job_id, per-item dest)

        if req.items:
            entries = [(it.source_url, it.dest_key, it.filename) for it in req.items]
        else:
            src = req.source
            try:
                objs = s3util.list_objects(src, limit=req.limit)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(502, f"list objects failed: {e}") from e
            entries = []
            for obj in objs:
                key = obj["key"]
                rel = key[len(src.prefix):].lstrip("/") if src.prefix else key
                dest_key = posixpath.join(req.dest_prefix, rel)
                try:
                    url = s3util.presign_get(src, key, req.presign_expiry_s)
                except Exception as e:  # noqa: BLE001
                    raise HTTPException(502, f"presign failed for {key}: {e}") from e
                entries.append((url, dest_key, posixpath.basename(key)))

        for source_url, dest_key, filename in entries:
            job_id = uuid.uuid4().hex
            per_dest = req.dest.model_copy(update={"key": dest_key})
            jobs.append(Job(
                job_id=job_id,
                filename=filename or os.path.basename(dest_key) or job_id,
                source_url=source_url,
                dest_bucket=req.dest.bucket,
                dest_key=dest_key,
                status=Status.QUEUED,
                uploaded_at=now,
            ))
            contexts.append((job_id, per_dest))

        store.insert_many(jobs)
        for job_id, per_dest in contexts:
            worker.submit(job_id, per_dest, req.params)
        return BatchResponse(count=len(jobs), job_ids=[j.job_id for j in jobs])

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
