# transcriber HTTP API

This document is self-contained: an LLM should be able to write a working client from it without reading the source.

## Conventions

- Base URL: `http://<host>:<port>` (default `http://0.0.0.0:8080`). Bound to LAN, no auth.
- All responses (except `GET /jobs/{id}/transcript`) are JSON encoded as UTF-8.
- All timestamps are unix milliseconds (`int64`).
- `job_id` is a UUIDv4 string assigned by the server.
- Error responses: `{"error": "<message>"}` with the appropriate HTTP status.
- CORS open (`Access-Control-Allow-Origin: *`).

## Job lifecycle

```
                        (fluidbatchd worker
                         picks it up)
queued  ─────────────────────────────────►  running
                                                 │
                                            (transcribe
                                              completes)
                                                 ▼
                                                done    (transcript ready)
   │                                             │
   │     (failure: bad audio, ffmpeg err, etc.)  │
   ▼                                             │
failed ◄─────────────────────────────────────────┘
```

`POST /jobs` creates a row in `queued`. The server feeds the path to the Swift daemon, which moves it through `running` → `done`/`failed`. The MP3 is deleted from disk the moment inference finishes (success only — failures keep the file for debugging until you `DELETE`).

## Endpoints

### `POST /jobs` — submit a file

| Form field | Type | Required | Notes |
|---|---|---|---|
| `file` | binary (`multipart/form-data`) | yes | The audio file. Anything ffmpeg can decode (mp3, wav, m4a, flac, ogg, opus). Max 1 GB by default. |
| `language` | string | no | ISO-like code, e.g. `ru`, `en`. Default = server's `-default-language` (`ru`). Empty string = auto-detect. |
| `filename` | string | no | What the server stores as the original name. Defaults to the multipart filename header. |

**`201 Created`**:
```json
{
  "job_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "status": "queued",
  "filename": "lecture.mp3"
}
```

**Errors:**
- `400` — missing `file` field, or invalid multipart.
- `413` — body exceeds `-max-upload-bytes`.
- `500` — disk full, can't write audio file.

**curl:**
```sh
curl -X POST \
     -F file=@lecture.mp3 \
     -F language=ru \
     http://m4.local:8080/jobs
```

---

### `GET /jobs/{id}` — job status & metadata

**`200 OK`**:
```json
{
  "job_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "filename": "lecture.mp3",
  "language": "ru",
  "status": "done",
  "uploaded_at": 1714972800000,
  "started_at": 1714972802000,
  "completed_at": 1714972810000,
  "duration_seconds": 1817.5,
  "processing_time_seconds": 4.85,
  "rtfx": 374.3,
  "confidence": 0.94
}
```

Fields are present only when populated:
- `started_at` — set when status moves to `running`.
- `completed_at`, `duration_seconds`, `processing_time_seconds`, `rtfx`, `confidence` — set when `done`.
- `error` — only on `failed`. A short message explaining why.

**Errors:**
- `404` — no job with this id.

**curl:**
```sh
curl http://m4.local:8080/jobs/f47ac10b-58cc-4372-a567-0e02b2c3d479
```

---

### `GET /jobs?status=&limit=` — list jobs

Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `status` | `queued` \| `running` \| `done` \| `failed` | all | Filter by status. |
| `limit` | int | 200 | 1–1000. |

Returns most-recent-first.

**`200 OK`**:
```json
[ <Job>, <Job>, ... ]
```
Each `<Job>` has the same shape as `GET /jobs/{id}`.

**curl:**
```sh
curl 'http://m4.local:8080/jobs?status=done&limit=50'
```

---

### `GET /jobs/{id}/transcript` — fetch the transcript JSON

Returns the full Parakeet output verbatim:

```json
{
  "audioFile": "/Users/akd/.transcriber/audio/<id>.mp3",
  "mode": "batch",
  "modelVersion": "v3",
  "text": "Лекция по Бхагават Гите …",
  "durationSeconds": 1817.5,
  "processingTimeSeconds": 4.85,
  "rtfx": 374.3,
  "confidence": 0.94,
  "wordTimings": [
    { "word": "Лекция", "startTime": 4.24, "endTime": 4.64, "confidence": 0.999 },
    { "word": "по",     "startTime": 4.64, "endTime": 4.80, "confidence": 0.991 },
    …
  ]
}
```

`wordTimings[]` carries per-word start/end times in seconds and an average confidence.

**Errors:**
- `404` — no job with this id.
- `409` — job exists but `status != "done"` (still running, queued, or failed).

**curl:**
```sh
curl http://m4.local:8080/jobs/<id>/transcript -o transcript.json
```

---

### `DELETE /jobs/{id}` — remove a job

Removes the SQLite row and the `transcripts/<id>.json` file. Idempotent — repeated calls return `404`.

**`204 No Content`**.

**Errors:**
- `404` — already gone.
- `409` — job is currently `running`. Wait for completion or failure first.

**curl:**
```sh
curl -X DELETE http://m4.local:8080/jobs/<id>
```

---

### `GET /healthz` — liveness & queue stats

**`200 OK`**:
```json
{
  "workers": 2,
  "queued": 0,
  "running": 1,
  "done": 47,
  "failed": 2,
  "model_loaded": true,
  "uptime_s": 3621
}
```

`model_loaded` is `false` until fluidbatchd emits its `READY` event (~5–15 s after start, longer on first run while downloading weights).

---

## Implementing a client

The minimal happy-path workflow is:

1. **Upload:** `POST /jobs` with the audio file, get back a `job_id`.
2. **Poll:** `GET /jobs/{id}` every 2–5 seconds until `status == "done"` or `"failed"`.
3. **Fetch:** if `done`, `GET /jobs/{id}/transcript` and save the JSON.
4. **Cleanup:** `DELETE /jobs/{id}`.

You can skip step 4 if you want to keep the transcripts around.

### Recommended polling cadence

The server is fast (single 30-min lecture takes ~5 s of compute). Poll every 2 seconds for the first minute, then back off to 5–10 s. Don't fire-and-forget on slow networks — uploads are the dominant cost; once you've uploaded N files, do all the polling in parallel.

### Concurrent uploads

There's no per-client limit. You can upload N files in parallel and the server queues them for sequential processing through the two ANE workers. Wall time scales linearly with audio duration once uploads are done.

### Failure handling

A `failed` job has a one-line `error` field describing what went wrong (usually an ffmpeg decode error or zero-byte audio). The MP3 stays on the server for debugging — `DELETE` to clean up. Re-upload to retry.

### Quality flag

A job whose `confidence < 0.5` is almost certainly non-target-language audio (e.g. a Russian-only model fed an English/Sanskrit chant track). The transcript will be garbage tokens. Surface those in your client UI as "needs review" rather than treating them as final.

### Example: 30-line Python client

```python
#!/usr/bin/env python3
"""Upload a file, wait for transcription, save and cleanup."""
import sys, time, json, requests

BASE = "http://m4.local:8080"

def transcribe(path: str, language: str = "ru") -> dict:
    with open(path, "rb") as f:
        r = requests.post(
            f"{BASE}/jobs",
            files={"file": (path, f, "audio/mpeg")},
            data={"language": language},
        )
    r.raise_for_status()
    job_id = r.json()["job_id"]

    # Poll. Fast for the first 60 s, then back off.
    deadline = time.time() + 3600
    interval = 2
    while time.time() < deadline:
        time.sleep(interval)
        meta = requests.get(f"{BASE}/jobs/{job_id}").json()
        if meta["status"] == "done":
            transcript = requests.get(f"{BASE}/jobs/{job_id}/transcript").json()
            requests.delete(f"{BASE}/jobs/{job_id}")
            return transcript
        if meta["status"] == "failed":
            raise RuntimeError(f"transcription failed: {meta.get('error')}")
        if time.time() - deadline + 3600 > 60:
            interval = 5
    raise TimeoutError(f"job {job_id} did not finish within 1 h")

if __name__ == "__main__":
    out = transcribe(sys.argv[1])
    print(out["text"][:500])
```

### Example: bash with curl + jq

```sh
#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-http://m4.local:8080}
file=$1

job_id=$(curl -sf -F file=@"$file" -F language=ru "$BASE/jobs" | jq -r .job_id)

while :; do
  status=$(curl -sf "$BASE/jobs/$job_id" | jq -r .status)
  case "$status" in
    done)   curl -sf "$BASE/jobs/$job_id/transcript"; break ;;
    failed) curl -sf "$BASE/jobs/$job_id" | jq -r .error >&2; exit 1 ;;
    *)      sleep 2 ;;
  esac
done
curl -sf -X DELETE "$BASE/jobs/$job_id" >/dev/null
```
