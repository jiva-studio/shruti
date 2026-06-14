# denoiser-service

LAN-local HTTP service for batch audio **denoising**. It is the sibling of
[`transcriber-service`](../transcriber-service/) and copies its data plane
(HTTP + SQLite job queue + worker pool, restart-safe), but the heavy lifting is
delegated to the existing [`denoise_mp3.py`](../audio-denoiser/denoise_mp3.py)
algorithm (RNNoise + optional spectral subtraction + normalization) instead of a
Swift ANE daemon.

```
client (any machine) ──HTTP──► denoiser-service (Python/FastAPI)
                              │   download source_url  ──► /tmp/<job>/in.mp3
                              │   denoise_mp3.py (subprocess, N workers)
                              │   upload                ──► s3://<bucket>/<key>
                              │   ~/.denoiser/jobs.db   (SQLite, restart-safe)
```

The service downloads the input from a (public) URL, denoises it, and uploads
the result to an S3-compatible bucket. **Input needs no credentials** (it's a
plain GET); only the **upload** does, and those credentials arrive *with each
job* — the service never persists them (see "Security" below).

## Why a service (vs. running the script directly)

Mirrors transcriber: a queue + worker pool with persistence so a remote machine
(e.g. an M4) can chew through a corpus while a thin local MCP
([`denoiser-mcp`](../denoiser-mcp/)) drives it. Measured throughput of the
algorithm itself: ~11× realtime (default pipeline) / ~3.8× (with spectral
subtraction) per worker on a Ryzen 7 6800U; faster single-thread on Apple
Silicon. Scale with `--workers` (RAM-bound: ~1–1.35 GB per worker).

## Requirements

- Python 3.10+
- `ffmpeg` / `ffprobe` on PATH (pydub decoding + duration probe)
- The denoise dependencies (`pyrnnoise`, `pydub`, `soundfile`, `numpy`, `scipy`)
  available to the interpreter that runs the algorithm. On Linux/Python 3.13
  pin `av==15.0.0` (newer PyAV breaks `pyrnnoise`'s `audiolab` dependency).

## Install & run

```sh
make venv          # creates .venv and installs requirements.txt
make run           # python -m denoiser_service
# or:
.venv/bin/python -m denoiser_service --addr 0.0.0.0:8091 --workers 2
```

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--addr` | `0.0.0.0:8091` | LAN binding. Use `127.0.0.1:8091` for localhost-only. |
| `--data-dir` | `~/.denoiser` | Holds `jobs.db`. |
| `--workers` | `2` | Concurrent denoise subprocesses. RAM-bound (~1–1.35 GB each). |
| `--denoiser-script` | autoresolved | Path to `denoise_mp3.py` (default: sibling `audio-denoiser/`). |
| `--python` | this interpreter | Interpreter with the denoise deps. |
| `--job-timeout` | `3600` | Max seconds per single denoise. |

## End-to-end example

```sh
curl -s -X POST http://m4.local:8091/jobs -H 'content-type: application/json' -d '{
  "source_url": "https://storage.yandexcloud.net/pub/lecture.mp3",
  "dest": {
    "bucket": "shruti-clean",
    "key": "clean/lecture.mp3",
    "access_key_id": "…", "secret_access_key": "…",
    "region": "ru-central1",
    "endpoint_url": "https://storage.yandexcloud.net",
    "acl": "public-read"
  },
  "params": { "normalize": true, "noise_profile": false }
}'
# → {"job_id":"…","status":"queued","filename":"lecture.mp3"}

curl -s http://m4.local:8091/jobs/<job_id> | jq   # poll until status=done → dest_url
```

## Batch (hundreds/thousands of files)

`POST /jobs/batch` queues many jobs in one call — either an explicit `items`
list, or a `source` bucket+prefix the service enumerates itself (it lists the
prefix, presigns a GET URL per object, and submits one job per file with output
keys mirroring the source layout under `dest_prefix`). Non-blocking; watch
progress with `/healthz` counts. `POST /source/list` enumerates a prefix for
discovery. See [`docs/API.md`](docs/API.md) for the full REST spec.

## Security

S3 secret keys are sent in the `POST /jobs` body, held **in memory only** for
the duration of the run, and dropped when the job finishes. They are never
written to `jobs.db` or logged. Because of this, a process restart cannot resume
in-flight jobs — at startup any job left `queued`/`running` is marked `failed`
with a "resubmit" message. Deploy on a trusted LAN/tailnet (the
[`denoiser-mcp`](../denoiser-mcp/) holds the creds and injects them per job).

## Tests

```sh
.venv/bin/python -m pytest -q
```
