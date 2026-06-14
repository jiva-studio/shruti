"""SQLite-backed job persistence. Thread-safe (SQLite serializes writes; we use
a short-lived connection per call with WAL + busy_timeout).

Credentials are never written here — only the non-secret job metadata.
"""
from __future__ import annotations

import sqlite3
import time
from typing import Optional

from .models import Job, Status

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_url TEXT NOT NULL,
  dest_bucket TEXT NOT NULL,
  dest_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
  uploaded_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  duration_seconds REAL,
  processing_time_seconds REAL,
  rtfx REAL,
  dest_url TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, uploaded_at);
"""

_COLS = (
    "job_id, filename, source_url, dest_bucket, dest_key, status, uploaded_at, "
    "started_at, completed_at, duration_seconds, processing_time_seconds, rtfx, "
    "dest_url, error"
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class Store:
    def __init__(self, path: str):
        self._path = path
        with self._conn() as c:
            c.executescript(_SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self._path, timeout=5.0)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=5000")
        c.row_factory = sqlite3.Row
        return c

    def insert(self, j: Job) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO jobs (job_id, filename, source_url, dest_bucket, dest_key, "
                "status, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (j.job_id, j.filename, j.source_url, j.dest_bucket, j.dest_key,
                 j.status.value, j.uploaded_at),
            )

    def insert_many(self, jobs: list[Job]) -> None:
        rows = [
            (j.job_id, j.filename, j.source_url, j.dest_bucket, j.dest_key,
             j.status.value, j.uploaded_at)
            for j in jobs
        ]
        with self._conn() as c:
            c.executemany(
                "INSERT INTO jobs (job_id, filename, source_url, dest_bucket, dest_key, "
                "status, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )

    def mark_running(self, job_id: str) -> None:
        with self._conn() as c:
            c.execute(
                "UPDATE jobs SET status='running', started_at=? "
                "WHERE job_id=? AND status IN ('queued','running')",
                (_now_ms(), job_id),
            )

    def mark_done(self, job_id: str, *, duration_s: float, proc_s: float,
                  rtfx: float, dest_url: str) -> None:
        with self._conn() as c:
            c.execute(
                "UPDATE jobs SET status='done', completed_at=?, duration_seconds=?, "
                "processing_time_seconds=?, rtfx=?, dest_url=? WHERE job_id=?",
                (_now_ms(), duration_s, proc_s, rtfx, dest_url, job_id),
            )

    def mark_failed(self, job_id: str, err: str) -> None:
        with self._conn() as c:
            c.execute(
                "UPDATE jobs SET status='failed', completed_at=?, error=? WHERE job_id=?",
                (_now_ms(), err, job_id),
            )

    def get(self, job_id: str) -> Optional[Job]:
        with self._conn() as c:
            row = c.execute(
                f"SELECT {_COLS} FROM jobs WHERE job_id=?", (job_id,)
            ).fetchone()
        return _row_to_job(row) if row else None

    def list(self, status: str = "", limit: int = 200) -> list[Job]:
        if limit <= 0 or limit > 1000:
            limit = 200
        with self._conn() as c:
            if status:
                rows = c.execute(
                    f"SELECT {_COLS} FROM jobs WHERE status=? "
                    "ORDER BY uploaded_at DESC LIMIT ?", (status, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    f"SELECT {_COLS} FROM jobs ORDER BY uploaded_at DESC LIMIT ?", (limit,),
                ).fetchall()
        return [_row_to_job(r) for r in rows]

    def delete(self, job_id: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM jobs WHERE job_id=?", (job_id,))

    def counts(self) -> dict[str, int]:
        out = {"queued": 0, "running": 0, "done": 0, "failed": 0}
        with self._conn() as c:
            for st, n in c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status"):
                out[st] = n
        return out

    def fail_orphans(self, msg: str) -> int:
        """At startup, any job left queued/running belongs to a previous process
        whose in-memory credentials are gone. Fail them with a clear message so
        the client can resubmit. Returns the number affected."""
        with self._conn() as c:
            cur = c.execute(
                "UPDATE jobs SET status='failed', completed_at=?, error=? "
                "WHERE status IN ('queued','running')",
                (_now_ms(), msg),
            )
            return cur.rowcount


def _row_to_job(r: sqlite3.Row) -> Job:
    return Job(
        job_id=r["job_id"],
        filename=r["filename"],
        source_url=r["source_url"],
        dest_bucket=r["dest_bucket"],
        dest_key=r["dest_key"],
        status=Status(r["status"]),
        uploaded_at=r["uploaded_at"],
        started_at=r["started_at"],
        completed_at=r["completed_at"],
        duration_seconds=r["duration_seconds"],
        processing_time_seconds=r["processing_time_seconds"],
        rtfx=r["rtfx"],
        dest_url=r["dest_url"],
        error=r["error"],
    )
