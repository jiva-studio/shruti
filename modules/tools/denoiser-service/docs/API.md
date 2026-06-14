# denoiser-service REST API

Base URL: `http://<host>:8091`. All bodies are JSON. Errors are
`{"error": "<message>"}` with the matching HTTP status.

## Job lifecycle

```
queued ──► running ──► done
                  └──► failed
```

Times are unix milliseconds. Metrics (`duration_seconds`,
`processing_time_seconds`, `rtfx`) and `dest_url` appear once `status=done`.

---

## `GET /healthz`

Liveness + queue snapshot.

```json
{
  "workers": 2, "queued": 0, "running": 1, "done": 12, "failed": 0,
  "denoiser_ready": true, "uptime_s": 384
}
```

`denoiser_ready` is `false` if the algorithm script or interpreter can't be
found — `POST /jobs` returns `503` until fixed.

---

## `POST /jobs`

Queue a denoise job. Returns `201`.

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `source_url` | string | yes | HTTP(S) URL of the input audio (downloaded by the service). |
| `dest.bucket` | string | yes | Destination S3 bucket. |
| `dest.key` | string | yes | Destination object key. |
| `dest.access_key_id` | string | yes | S3 access key (in memory only — never persisted). |
| `dest.secret_access_key` | string | yes | S3 secret key (in memory only). |
| `dest.region` | string | no | e.g. `ru-central1`, `us-east-1`. |
| `dest.endpoint_url` | string | no | Custom endpoint for non-AWS S3 (Yandex/MinIO). |
| `dest.acl` | string | no | Canned ACL, e.g. `public-read`. |
| `dest.content_type` | string | no | Default `audio/mpeg`. |
| `filename` | string | no | Display name; defaults to the URL basename. |
| `params.normalize` | bool | no | Loudness-match the clean to the original (EBU R128). Default `true`. |
| `params.noise_profile` | bool | no | Spectral subtraction (slower ~3×). Default `false`. |
| `params.sample_rate` | int | no | Default `48000`. |

### Response `201`

```json
{ "job_id": "9ce0…04", "status": "queued", "filename": "lecture.mp3" }
```

`503` if the denoiser isn't ready; `422` on a malformed body.

---

## `POST /jobs/batch`

Queue many jobs in one call (hundreds/thousands). Provide **exactly one** of
`items` (explicit) or `source` (enumerate). Returns `201`.

### Explicit mode

```json
{
  "dest": { "bucket": "out", "access_key_id": "…", "secret_access_key": "…",
            "endpoint_url": "https://storage.yandexcloud.net", "acl": "public-read" },
  "items": [
    { "source_url": "https://…/1.mp3", "dest_key": "clean/1.mp3" },
    { "source_url": "https://…/2.mp3", "dest_key": "clean/2.mp3" }
  ],
  "params": { "normalize": true }
}
```

### Enumerate mode

The service lists `source.bucket/source.prefix`, presigns a GET URL for every
object (so private sources download through the unchanged worker), and submits
one job per file. Output keys mirror the source layout under `dest_prefix`.

```json
{
  "dest": { "bucket": "out", "access_key_id": "…", "secret_access_key": "…",
            "endpoint_url": "https://storage.yandexcloud.net", "acl": "public-read" },
  "source": { "bucket": "in", "prefix": "raw/",
              "access_key_id": "…", "secret_access_key": "…",
              "endpoint_url": "https://storage.yandexcloud.net" },
  "dest_prefix": "clean/",
  "presign_expiry_s": 86400,
  "limit": 100000,
  "params": { "normalize": true }
}
```

### Response `201`

```json
{ "count": 1240, "job_ids": ["…", "…", …] }
```

Non-blocking — the jobs queue and the worker pool drains them. Watch progress
via `GET /healthz` counts or `GET /jobs?status=running`. `400` if neither/both
of `items`/`source` are given; `502` on an S3 list/presign error.

---

## `POST /source/list`

Enumerate a source bucket/prefix (credentials passed through, never stored).

```json
{ "source": { "bucket": "in", "prefix": "raw/",
              "access_key_id": "…", "secret_access_key": "…",
              "endpoint_url": "https://storage.yandexcloud.net" },
  "limit": 100000 }
```

Response: `{ "count": 1240, "objects": [ { "key": "raw/a.mp3", "size": 12345 }, … ] }`.

---

## `GET /jobs/{job_id}`

Job metadata. `404` if unknown.

```json
{
  "job_id": "9ce0…04", "filename": "lecture.mp3",
  "source_url": "https://…/lecture.mp3",
  "dest_bucket": "lectorium-clean", "dest_key": "clean/lecture.mp3",
  "status": "done", "uploaded_at": 1781420659286,
  "started_at": 1781420659298, "completed_at": 1781420714638,
  "duration_seconds": 600.0, "processing_time_seconds": 55.0, "rtfx": 10.9,
  "dest_url": "https://storage.yandexcloud.net/lectorium-clean/clean/lecture.mp3"
}
```

No credential fields are ever returned (or stored).

---

## `GET /jobs?status=&limit=`

Recent jobs, newest first. `status` ∈ `queued|running|done|failed` (empty =
all). `limit` default 200, max 1000. Returns a JSON array of job objects.

---

## `DELETE /jobs/{job_id}`

Remove a finished/failed job record. `204` on success, `404` if unknown,
`409` if the job is currently `running`.
