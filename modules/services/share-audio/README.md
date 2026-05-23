# share-audio

Cuts a fragment from an MP3 stored in S3-compatible object storage and
uploads it back as a public excerpt under `public/shares/audio/`.
Lives behind Caddy at `/share/audio/` on the host stack.

## API

`GET /healthz` — `200 {"status":"ok"}`

`POST /excerpts`

```json
{
  "source_key": "audio/lectures/2025-01-15.mp3",
  "start_ms":   125000,
  "end_ms":     187000,
  "excerpt_id": "optional-stable-id"
}
```

`200 OK`

```json
{
  "excerpt_id": "abc123",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/public/shares/audio/abc123.mp3",
  "ready": true
}
```

Validation errors → `400 {"detail": "<msg>"}`. S3 / ffmpeg failures
→ `502 {"detail": "<msg>"}`.

Idempotent on `excerpt_id`: a repeat with the same id returns the
cached URL without re-cutting. If omitted, a 32-char hex id is minted.

Excerpt length is capped at 10 minutes. `excerpt_id` must match
`[A-Za-z0-9_-]{1,64}`.

## How it works

`ffmpeg -ss <start> -i <src> -t <dur> -c copy <dst>` — stream copy, no
re-encode. Cuts snap to the nearest MP3 frame boundary (~26 ms).
Sub-second wallclock per request.

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8082` | |
| `BUCKET` (or `SHRUTI_S3_BUCKET`) | required | |
| `EXCERPTS_PREFIX` | `public/shares/audio` | |
| `EXCERPTS_PUBLIC_BASE` | (unset) | Optional CDN base, overrides the virtual-hosted URL. |
| `AWS_REGION` | `us-east-1` | |
| `S3_ENDPOINT_URL` | (unset) | For S3-compatible (Yandex Object Storage, MinIO). |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | |
| `ENV`, `SERVICE_VERSION`, `LOG_LEVEL` | `dev`, `dev`, `info` | Log envelope fields. |

AWS credentials are read from the environment
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

## No auth

There is no auth on `/excerpts`. Caddy rate-limits to 60/min/IP.
Stream-copy is cheap; the abuse surface is S3 egress, not CPU.

## Local dev

```bash
docker compose -f infra/app/compose/docker-compose.yml \
               -f infra/app/compose/docker-compose.dev.yml \
               up --build share-audio
```
