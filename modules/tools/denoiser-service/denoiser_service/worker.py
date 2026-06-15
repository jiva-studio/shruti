"""Worker pool: N threads pull job ids off a queue and run the
download → denoise → upload pipeline, each in its own subprocess.

Per-job credentials live ONLY in the in-memory ``_pending`` map, never in
SQLite. A process restart therefore can't resume a job (the keys are gone);
such orphans are failed at startup with a resubmit hint (store.fail_orphans).
"""
from __future__ import annotations

import logging
import os
import queue
import tempfile
import threading
import time
from dataclasses import dataclass

from .models import DenoiseParams, S3Dest
from .runner import Runner
from .store import Store
from . import s3util

log = logging.getLogger("denoiser.worker")


@dataclass
class _Ctx:
    dest: S3Dest
    params: DenoiseParams


class Worker:
    def __init__(self, store: Store, runner: Runner, workers: int, job_timeout: float):
        self._store = store
        self._runner = runner
        self._n = max(1, workers)
        self._timeout = job_timeout
        self._q: "queue.Queue[str]" = queue.Queue()
        self._pending: dict[str, _Ctx] = {}
        self._lock = threading.Lock()
        self._threads: list[threading.Thread] = []
        self._stop = threading.Event()

    def start(self) -> None:
        for i in range(self._n):
            t = threading.Thread(target=self._loop, name=f"denoise-{i}", daemon=True)
            t.start()
            self._threads.append(t)
        log.info("worker pool started (%d threads)", self._n)

    def stop(self) -> None:
        self._stop.set()

    def submit(self, job_id: str, dest: S3Dest, params: DenoiseParams) -> None:
        with self._lock:
            self._pending[job_id] = _Ctx(dest=dest, params=params)
        self._q.put(job_id)

    def ready(self) -> bool:
        return self._runner.ready()

    # --- internals ---

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                self._process(job_id)
            except Exception as e:  # noqa: BLE001 — last-resort guard
                log.exception("job %s crashed", job_id)
                self._store.mark_failed(job_id, f"worker crash: {e}")
            finally:
                with self._lock:
                    self._pending.pop(job_id, None)
                self._q.task_done()

    def _process(self, job_id: str) -> None:
        with self._lock:
            ctx = self._pending.get(job_id)
        if ctx is None:
            self._store.mark_failed(job_id, "internal: missing job context")
            return

        job = self._store.get(job_id)
        if job is None:
            return
        self._store.mark_running(job_id)
        log.info("job %s: running (%s)", job_id, job.source_url)

        tmpdir = tempfile.mkdtemp(prefix=f"denoise-{job_id}-")
        in_path = os.path.join(tmpdir, "in.mp3")
        out_path = os.path.join(tmpdir, "clean.mp3")
        try:
            s3util.download(job.source_url, in_path)
            duration = self._runner.probe_duration(in_path)

            t0 = time.perf_counter()
            self._runner.denoise(in_path, out_path, ctx.params, timeout=self._timeout)
            proc_s = time.perf_counter() - t0

            dest_url = s3util.upload(out_path, ctx.dest)
            rtfx = (duration / proc_s) if proc_s > 0 else 0.0
            self._store.mark_done(
                job_id, duration_s=duration, proc_s=proc_s, rtfx=rtfx, dest_url=dest_url
            )
            log.info("job %s: done (%.1fs, %.1fx) -> %s", job_id, proc_s, rtfx, dest_url)
        except Exception as e:  # noqa: BLE001
            self._store.mark_failed(job_id, str(e))
            log.warning("job %s: failed: %s", job_id, e)
        finally:
            _rmtree_quiet(tmpdir)


def _rmtree_quiet(path: str) -> None:
    import shutil
    try:
        shutil.rmtree(path, ignore_errors=True)
    except OSError:
        pass
