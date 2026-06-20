# share-audio

A small Go HTTP service that cuts a fragment out of an MP3 stored in S3-compatible object storage and uploads the result back as a public excerpt under `public/shares/audio/{id}.mp3`. It runs as a container in the host app stack (`infra/app/compose`) behind Caddy at `/share/audio/`, not as a serverless function. A `POST /excerpts` with `{source_key, start_ms, end_ms}` validates the range, HEAD-probes S3 for an existing object (idempotency), and — on a miss — dispatches a background worker that downloads the source, runs `ffmpeg -c copy`, uploads the slice, and returns the predicted public URL. The mobile app shares that URL like any other piece of content.

## Layout

```
modules/services/share-audio/
├── cmd/share-audio/main.go        boot: config, S3 client, dispatcher, chi server, graceful shutdown
├── internal/config/config.go      env-driven Config loaded once at boot
├── internal/httpx/server.go       chi router, /healthz + POST /excerpts, JSON error envelope
├── internal/httpx/dispatcher.go   key-coalesced background worker pool
├── internal/httpx/middleware.go   recoverer + per-request slog child + request id
├── internal/pipeline/cut.go       cloud-agnostic Prepare + Cut (validate → HEAD → download → ffmpeg → upload)
├── internal/ffmpeg/cut.go         shells out to ffmpeg, stream-copy slice
├── internal/storage/s3.go         aws-sdk-go-v2 S3 wrapper: Exists / DownloadTo / Upload / BuildURL
├── internal/logx/logx.go          slog JSON envelope, context-carried child loggers
├── Dockerfile                     golang:1.24-alpine build → alpine:3.20 runtime (ffmpeg + tini)
├── go.mod / go.sum                module github.com/akdasa-studios/lectorium-share-audio
└── README.md
```

The service is wired into the stack in `infra/app/compose/docker-compose.yml` (service `share-audio`) and routed by `infra/app/compose/caddy/Caddyfile` under `handle_path /share/audio/*`. There is no serverless framework, no Lambda, no Yandex Cloud Function, and no committed ffmpeg layer — ffmpeg comes from the runtime image (`apk add ffmpeg`).

## API

`GET /healthz` → `200 {"status":"ok","build":{"sha":"...","time":"..."}}`

`POST /excerpts` (Caddy strips the `/share/audio` prefix, so the service sees `/excerpts`):

```json
{
  "source_key": "public/tracks/<trackId>/audio/source.mp3",
  "start_ms": 125000,
  "end_ms": 187000,
  "excerpt_id": "optional-stable-id"
}
```

```json
{
  "excerpt_id": "abc123",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/public/shares/audio/abc123.mp3",
  "ready": true
}
```

Status codes:

- **200** — cache hit (object already exists), `ready: true`.
- **202** — cold path: the cut was dispatched to a background worker; the response carries the predicted URL with `ready: false`. The client polls/loads the URL once the worker finishes.
- **400** `{"detail": "<msg>"}` — validation error (missing/oversized range, bad `excerpt_id`, `source_key` outside the allowed prefix, malformed body).
- **502** `{"detail": "<msg>"}` — upstream failure (S3 HEAD/GET/PUT, ffmpeg).

The error envelope key is `detail` (mirrors the FastAPI service it replaced), deliberately distinct from share-video's `error` key.

### Request constraints

- `source_key` must start with `SOURCE_KEY_PREFIX` (default `public/tracks/`) — a request for any other prefix is rejected with 400 before any S3 GET, so anonymous callers can't probe sibling prefixes in the same bucket.
- `end_ms` must be `> start_ms`, and the excerpt may be at most **10 minutes** (`MaxExcerptMs = 10*60*1000`, hard-coded in `config.go`).
- `excerpt_id`, if supplied, must match `^[A-Za-z0-9_-]{1,64}$`. If omitted, a 32-char UUID-hex id is minted (dashes stripped, parity with `uuid4().hex`).
- Repeated calls with the same resolved id short-circuit on the S3 HEAD and return the existing URL without re-cutting.

## Request flow

```mermaid
sequenceDiagram
    autonumber
    participant Client as Mobile app / CLI
    participant Caddy as Caddy /share/audio/*
    participant Svc as share-audio (Go, :8082)
    participant Disp as Dispatcher (background)
    participant FF as ffmpeg (stream-copy)
    participant S3 as S3 bucket / public/shares/audio

    Client->>Caddy: POST /share/audio/excerpts {source_key, start_ms, end_ms, [excerpt_id]}
    Caddy->>Svc: POST /excerpts (prefix stripped)
    Note over Svc: Prepare — validate range/id/prefix, resolve excerpt_id
    Svc->>S3: HEAD public/shares/audio/{id}.mp3
    alt object exists (cache hit)
        Svc-->>Client: 200 {url, ready:true}
    else miss (cold path)
        Svc->>Disp: Dispatch(id, work)
        Svc-->>Client: 202 {url, ready:false}
        Disp->>S3: GET {source_key}
        Disp->>FF: ffmpeg -ss start -i src -t dur -c copy dst
        Disp->>S3: PUT public/shares/audio/{id}.mp3 (ContentType audio/mpeg)
    end
```

The heavy phase (download a multi-hundred-MB source, ffmpeg trim, upload) runs in a background goroutine off the request goroutine, so a client disconnect doesn't kill the upload. The `Prepare` fast path (validation + at most one S3 HEAD) is the only work done synchronously before responding.

The cut uses `ffmpeg -nostdin -y -ss <start> -i <src> -t <dur> -c copy -loglevel error <dst>` — stream copy, no re-encode — so excerpt boundaries snap to MP3 frame edges (~26 ms). Wallclock is sub-second once the source is downloaded.

## Concurrency model

```mermaid
graph TD
    POST["POST /excerpts"] --> PREP["Cutter.Prepare<br/>validate + S3 HEAD"]
    PREP -->|cached| R200["200 ready:true"]
    PREP -->|miss| DISP["Dispatcher.Dispatch(excerpt_id, work)"]
    DISP --> R202["202 ready:false"]
    DISP --> WORK["background goroutine<br/>ctx = Background + 5min timeout"]
    WORK --> CUT["Cutter.Cut: GET → ffmpeg → PUT"]

    classDef sync fill:#a6e3a1,stroke:#6c7086,color:#1e1e2e;
    classDef async fill:#cba6f7,stroke:#6c7086,color:#1e1e2e;
    class POST,PREP,R200,R202,DISP sync;
    class WORK,CUT async;
```

The `Dispatcher` (`internal/httpx/dispatcher.go`) coalesces background work by `excerpt_id`: the first call for an id starts a goroutine and marks the key in-flight; concurrent calls for the same id while the worker runs are dropped, so N parallel POSTs for the same excerpt run a single cut. The key is released once the worker returns (success or failure), so a later request can re-trigger a failed cut. Each worker runs on a fresh `context.Background()` capped by a **5-minute** timeout (set in `main.go`), independent of the HTTP request context. On context cancel, ffmpeg gets SIGTERM then SIGKILL after a 5 s `WaitDelay`.

## Storage and URLs

`internal/storage/s3.go` wraps `aws-sdk-go-v2` with exactly four operations: `Exists` (HeadObject, treating `NotFound`/`NoSuchKey` as a clean miss), `DownloadTo` (GetObject streamed to a temp file), `Upload` (one-shot PutObject with `ContentType: audio/mpeg`), and `BuildURL`. `BuildURL` returns `EXCERPTS_PUBLIC_BASE + "/" + key` when a CDN base is set, otherwise the virtual-hosted form `https://<bucket>.s3.<region>.amazonaws.com/<key>`.

An optional `S3_ENDPOINT_URL` lets the same client target any S3-compatible store (Yandex Object Storage, MinIO) by overriding the SDK base endpoint. Public read of the result is the bucket's own policy on `public/*`; the service sets no object-level ACL.

## Configuration

All settings come from env vars loaded once by `internal/config/config.go`:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8082` | HTTP listen port. |
| `BUCKET` (or `LECTORIUM_S3_BUCKET`) | required | Target bucket; boot fails if unset. |
| `EXCERPTS_PREFIX` | `public/shares/audio` | Upload key prefix for excerpts. |
| `SOURCE_KEY_PREFIX` | `public/tracks/` | Only prefix the service will read from; others → 400. |
| `EXCERPTS_PUBLIC_BASE` | (unset) | Optional CDN base; overrides the virtual-hosted S3 URL. |
| `AWS_REGION` | `us-east-1` | |
| `S3_ENDPOINT_URL` | (unset) | For S3-compatible stores (YC Object Storage, MinIO). |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | |
| `ENV`, `SERVICE_VERSION`, `LOG_LEVEL` | `dev`, `dev`, `info` | slog envelope fields. |
| `LECTORIUM_BUILD_SHA`, `LECTORIUM_BUILD_TIME` | (build args) | Stamped on `/healthz`. |

AWS credentials are read from the standard environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) via the default SDK credential chain. `MaxExcerptMs` is not env-configurable — it is fixed at 10 minutes in code.

## Deployment

```mermaid
graph LR
    Client["Mobile app / CLI"] --> Caddy["Caddy edge<br/>/share/audio/*<br/>rate-limit 60/min/IP"]
    Caddy -->|handle_path strips prefix| Svc["share-audio container<br/>Go :8082"]
    Svc -. aws-sdk-go-v2 .-> S3[("S3 bucket<br/>public/shares/audio/*")]

    WT["Watchtower"] -.->|poll ghcr :latest| Svc

    classDef edge fill:#89dceb,stroke:#6c7086,color:#1e1e2e;
    classDef svc fill:#cba6f7,stroke:#6c7086,color:#1e1e2e;
    classDef store fill:#f9e2af,stroke:#6c7086,color:#1e1e2e;
    class Caddy edge;
    class Svc,WT svc;
    class S3 store;
```

The service ships as the image `ghcr.io/akdasa-studios/lectorium-share-audio:${LECTORIUM_SHARE_AUDIO_TAG:-latest}` and is declared in `infra/app/compose/docker-compose.yml`. The two-stage Dockerfile builds a static `CGO_ENABLED=0` binary, then runs it on `alpine:3.20` with `ffmpeg`, `curl`, `ca-certificates`, and `tini` (PID-1 signal forwarding) as an unprivileged `share` user. The compose entry sets `BUCKET`, `EXCERPTS_PREFIX`, `AWS_REGION`, `ENV`, `SERVICE_VERSION`, runs under the shared `app-hardening` anchor, and has a `curl /healthz` healthcheck. It carries the `com.centurylinklabs.watchtower.enable: "true"` label, so Watchtower rolls new `:latest` images automatically.

Caddy routes `/share/audio/*` to `share-audio:8082` with `handle_path` (prefix stripped), a `request_body max_size 100KB` cap, and a `share_audio` rate-limit zone of 60 requests/minute per client IP. CORS is set both at the Caddy edge (global `header` block, `Access-Control-Allow-Origin *`) and inside the service itself — `internal/httpx/server.go` mounts chi's `cors.Handler` allowing `*` origins, `POST`/`OPTIONS` methods, and the `Content-Type` header. The service also caps the JSON body at 32 KB (`maxBodyBytes` in `server.go`) independently of the Caddy 100 KB edge cap.

## Constraints worth remembering

- **Excerpt length capped at 10 minutes** in code; longer ranges are rejected with 400 at validation.
- **Stream-copy only.** Cuts snap to MP3 frame boundaries (~26 ms). No re-encode, no transcoding to other codecs.
- **Source reads are prefix-gated** to `SOURCE_KEY_PREFIX` (default `public/tracks/`) — the service refuses to read arbitrary keys even though it has bucket credentials.
- **Cold cuts are asynchronous** — a miss returns 202 with `ready: false` and the predicted URL; the object appears once the background worker uploads it. Clients must tolerate the URL 404'ing briefly before the cut completes.

## Manual operations

```bash
# Health / build stamp
curl -fsS https://<host>/share/audio/healthz

# Smoke-test a cut
curl -X POST https://<host>/share/audio/excerpts \
  -H 'Content-Type: application/json' \
  -d '{"source_key":"public/tracks/<id>/audio/source.mp3","start_ms":5000,"end_ms":15000,"excerpt_id":"smoke"}'

# Local dev (compose)
docker compose -f infra/app/compose/docker-compose.yml \
               -f infra/app/compose/docker-compose.dev.yml \
               up --build share-audio
```
