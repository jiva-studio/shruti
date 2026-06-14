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
| `params.normalize` | bool | no | Default `true`. |
| `params.noise_profile` | bool | no | Spectral subtraction (slower ~3×). Default `false`. |
| `params.mix_min` | number | no | % original mixed back where no voice (0-100). Default `0`. |
| `params.mix_max` | number | no | % original mixed back where voice present (0-100). Default `0`. |
| `params.sample_rate` | int | no | Default `48000`. |

### Response `201`

```json
{ "job_id": "9ce0…04", "status": "queued", "filename": "lecture.mp3" }
```

`503` if the denoiser isn't ready; `422` on a malformed body.

---

## `GET /jobs/{job_id}`

Job metadata. `404` if unknown.

```json
{
  "job_id": "9ce0…04", "filename": "lecture.mp3",
  "source_url": "https://…/lecture.mp3",
  "dest_bucket": "shruti-clean", "dest_key": "clean/lecture.mp3",
  "status": "done", "uploaded_at": 1781420659286,
  "started_at": 1781420659298, "completed_at": 1781420714638,
  "duration_seconds": 600.0, "processing_time_seconds": 55.0, "rtfx": 10.9,
  "dest_url": "https://storage.yandexcloud.net/shruti-clean/clean/lecture.mp3"
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
