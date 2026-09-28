# share-audio

Cuts a fragment from an MP3 in the storage zone and uploads it back as a
public excerpt under `public/shares/audio/`.
Lives behind Caddy at `/share/audio/` on origin.

## API

`GET /healthz` — `200 {"status":"ok"}`

`POST /excerpts`

```json
{
  "source_key": "public/tracks/abc/audio/original.mp3",
  "start_ms":   125000,
  "end_ms":     187000,
  "excerpt_id": "optional-stable-id"
}
```

`200 OK`

```json
{
  "excerpt_id": "abc123",
  "url": "<EXCERPTS_PUBLIC_BASE>/public/shares/audio/abc123.mp3",
  "ready": true
}
```

Validation errors → `400 {"detail": "<msg>"}`. Storage / ffmpeg failures
→ `502 {"detail": "<msg>"}`.

Idempotent on `excerpt_id`: a repeat with the same id returns the
cached URL without re-cutting. If omitted, a 32-char hex id is minted.

Excerpt length is capped at 10 minutes. `excerpt_id` must match
`[A-Za-z0-9_-]{1,64}`.

## How it works

`ffmpeg -ss <start> -i <src> -t <dur> -c copy <dst>` — stream copy, no
re-encode. Cuts snap to the nearest MP3 frame boundary (~26 ms).
`<src>` is the source's pull-zone URL, so ffmpeg range-reads only the bytes
around the cut; the excerpt is written through the Bunny storage API.

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8082` | |
| `STORAGE_ZONE` | required | Bunny storage zone. |
| `STORAGE_KEY` | required | Storage-zone password. |
| `STORAGE_ENDPOINT` | `https://storage.bunnycdn.com` | Storage API host. |
| `EXCERPTS_PUBLIC_BASE` | required | Pull zone in front of the storage zone. |
| `EXCERPTS_PREFIX` | `public/shares/audio` | |
| `SOURCE_KEY_PREFIX` | `public/tracks/` | The only prefix a source may come from. |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | |
| `ENV`, `SERVICE_VERSION`, `LOG_LEVEL` | `dev`, `dev`, `info` | Log envelope fields. |

The service refuses to start without the three required values.

## No auth

There is no auth on `/excerpts`. Caddy rate-limits to 60/min/IP.
Stream-copy is cheap; the abuse surface is storage egress, not CPU.

## Local dev

```bash
docker compose -f infra/app/compose/docker-compose.yml \
               -f infra/app/compose/docker-compose.dev.yml \
               up --build share-audio
```
