# denoiser-mcp

Thin MCP wrapper around [`denoiser-service`](../denoiser-service/), the sibling
of [`transcriber-mcp`](../transcriber-mcp/). It runs **locally** (stdio, spawned
by the agent) and points at a **remote** denoiser-service (e.g. on an M4). It
also holds the **S3 upload credentials**, swappable at runtime via
`set_s3_config`, and injects them into every job request — so the service never
stores secrets.

```
Claude Code ──stdio──► denoiser-mcp (local) ──HTTP──► denoiser-service (remote M4)
                       holds: service URL + S3 creds (atomic, swappable)
```

## Build & run

```sh
make build
# stdio (for Claude Code / agents that spawn the binary):
./bin/denoiser-mcp -stdio -service-url http://audio-host:8091
# or HTTP transport (streamable + SSE on :8092):
./bin/denoiser-mcp -service-url http://audio-host:8091
```

### Flags

| Flag | Default | Notes |
|---|---|---|
| `-stdio` | false | Serve over stdin/stdout instead of HTTP. |
| `-service-url` | `http://localhost:8091` | Upstream denoiser-service. Swappable via `set_service_url`. |
| `-addr` | `0.0.0.0:8092` | HTTP listen address (HTTP mode only). |
| `-token` | "" | Optional bearer token (HTTP mode only). |
| `-max-timeout` | `3600s` | Upper bound on `denoise_wait timeout_s`. |

S3 config can be preloaded from env: `DENOISER_S3_BUCKET`,
`DENOISER_S3_ACCESS_KEY_ID`, `DENOISER_S3_SECRET_ACCESS_KEY`,
`DENOISER_S3_REGION`, `DENOISER_S3_ENDPOINT_URL`, `DENOISER_S3_ACL`.

## Tools

| Tool | Purpose |
|---|---|
| `set_s3_config` | Set upload bucket + credentials (+ region/endpoint/acl) at runtime. |
| `get_s3_config` | Show the current S3 config (secret masked). |
| `denoise_wait` | Queue a job (`source_url` → `dest_key`) and long-poll until done. `timeout_s=0` enqueues and returns the id. Accepts the strategy params below. |
| `denoise_batch` | Fan out hundreds/thousands of jobs in one call. Non-blocking. Enumerate a `source_prefix` (service lists + presigns each file) or pass explicit `items_json`. Accepts the strategy params below. |
| `list_objects` | List a bucket/prefix (using the S3 config creds) to discover files before a batch. |
| `get_job` | Fetch one job's status / `dest_url` / metrics. |
| `list_jobs` | List recent jobs, optional status filter. |
| `delete_job` | Remove a finished/failed job. |
| `get_service_url` / `set_service_url` | Inspect / repoint the upstream service. |
| `health` | Probe this MCP + the upstream service `/healthz`. |

## Cleaning strategies

`denoise_wait` / `denoise_batch` take an optional `strategy` (default `deepfilternet`):

| Strategy | What it does |
|---|---|
| `deepfilternet` (default) | DeepFilterNet3 learned speech denoiser — best on archival hiss/static, preserves the voice, runs real-time on CPU. |
| `afftdn` | ffmpeg FFT denoise — fast, no ML deps, milder (leaves more residual). |
| `rnnoise` | RNNoise speech denoiser, straight output. Aggressive — can leave dead-silent pauses. |
| `rnnoise-mix` | RNNoise blended back with the original by voice probability — keeps a natural noise floor in pauses. |
| `afftdn-rnnoise-mix` | afftdn → RNNoise → original blended back. |

Knobs: `nr` (afftdn noise reduction dB, default 12), `nf` (afftdn noise floor dB,
default -25), `mix_min`/`mix_max` (rnnoise-mix original ratio in pauses / on
voice, default 0.10 / 0.25).

## Typical flow

```
set_s3_config bucket=shruti-clean access_key_id=… secret_access_key=… \
              region=ru-central1 endpoint_url=https://storage.yandexcloud.net acl=public-read
denoise_wait source_url=https://…/lecture.mp3 dest_key=clean/lecture.mp3
# → { "status": "done", "dest_url": "https://…/clean/lecture.mp3", "rtfx": 10.9, ... }
```

## Batch (hundreds/thousands of files)

```
set_s3_config bucket=shruti-clean access_key_id=… secret_access_key=… \
              region=ru-central1 endpoint_url=https://storage.yandexcloud.net acl=public-read
list_objects  prefix=raw/ bucket=shruti-raw          # discover what's there
denoise_batch source_bucket=shruti-raw source_prefix=raw/ dest_prefix=clean/
# → { "count": 1240, "job_ids_preview": [...], "note": "poll health or list_jobs for progress" }
health                                                   # queued/running/done/failed counts
```

`denoise_batch` is non-blocking: the remote service lists the prefix, presigns
each object (so private sources download fine), queues one job per file, and the
worker pool drains them. Output keys mirror the source layout under
`dest_prefix`. Watch progress with `health` or `list_jobs status=running`.

Credentials live only in this process (atomic pointer; in-flight jobs keep their
snapshot, new calls observe the swap) and ride with each job request. The
service holds nothing.
