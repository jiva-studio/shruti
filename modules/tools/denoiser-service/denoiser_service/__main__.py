"""denoiser-service entrypoint.

    python -m denoiser_service [--addr 0.0.0.0:8091] [--data-dir ~/.denoiser]
        [--workers 2] [--denoiser-script PATH] [--python PATH] [--job-timeout 3600]

On start it fails any jobs orphaned by a previous run (their in-memory S3
credentials are gone — see worker.py) so clients get a clear resubmit signal.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time

import uvicorn

from .app import create_app
from .runner import Runner, default_noise_profile, resolve_script
from .store import Store
from .worker import Worker


def default_data_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".denoiser")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="denoiser-service")
    p.add_argument("--addr", default="0.0.0.0:8091", help="HTTP listen address host:port")
    p.add_argument("--data-dir", default=default_data_dir(), help="dir for jobs.db")
    p.add_argument("--workers", type=int, default=2, help="concurrent denoise workers")
    p.add_argument("--denoiser-script", default=None,
                   help="path to denoise_mp3.py (default: sibling audio-denoiser/)")
    p.add_argument("--python", default=sys.executable,
                   help="python interpreter with denoise deps (default: this one)")
    p.add_argument("--job-timeout", type=float, default=3600.0,
                   help="max seconds for a single denoise subprocess")
    p.add_argument("--log-level", default="info")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("denoiser")

    os.makedirs(args.data_dir, exist_ok=True)
    script = resolve_script(args.denoiser_script)
    runner = Runner(
        python=args.python,
        script=script,
        noise_profile=default_noise_profile(script),
    )
    log.info("denoiser script: %s (python=%s)", script, args.python)
    if not runner.ready():
        log.warning("denoiser not ready — script or interpreter missing; "
                    "POST /jobs will return 503 until fixed")

    store = Store(os.path.join(args.data_dir, "jobs.db"))
    n = store.fail_orphans("service restarted; credentials lost — resubmit the job")
    if n:
        log.info("failed %d orphaned job(s) from a previous run", n)

    worker = Worker(store, runner, workers=args.workers, job_timeout=args.job_timeout)
    worker.start()

    app = create_app(store, worker, workers=args.workers, started_at=time.time())

    host, _, port = args.addr.rpartition(":")
    log.info("denoiser-service listening on %s (data=%s, workers=%d)",
             args.addr, args.data_dir, args.workers)
    uvicorn.run(app, host=host or "0.0.0.0", port=int(port), log_config=None)
    worker.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
