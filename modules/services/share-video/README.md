# share-video

Renders a 9:16 720×1280 reel from an MP3 fragment plus caller-provided
text. Words are highlighted in sync with the audio, on a background
pulled from a theme pack in S3, with an optional title card and a
trailing logo clip.

Long-running Go container. HTTP front + queue worker live in the same
process; concurrency is intentionally 1 (ffmpeg at 720p already eats
~1.75 vCPU on the host).

## API

`GET /healthz` — `200 {"status":"ok"}`. No auth.

`POST /reels` — JWT-protected (RS256 Bearer). Body:

```json
{
  "source_key": "public/tracks/<id>/audio/foo.mp3",
  "start_ms":   12000,
  "end_ms":     90000,
  "text":       "Точный транскрипт фрагмента…",
  "lang":       "ru",
  "theme":      "prabhupada",
  "video_id":   "optional-stable-id",
  "title":      "optional title"
}
```

Cache hit on `video_id` → `200 {"video_id","ready":true,"url"}` if the
existing task is `done`, otherwise `202 {"video_id","ready":false,"url"?,"error"?}`.
Fresh enqueue → `202 {"video_id","ready":false}`. The caller polls
`GET /reels/:id` until `ready:true`.

`GET /reels/:id` — JWT-protected. Returns the same envelope as the cache-hit
response above. Ownership is checked at the SQL level
(`payload->>'user_id' = sub`); a non-match returns `404 {"error":"not found"}`,
never `403`, so foreign video_ids cannot be probed via existence checks.

Error envelopes: `{"error": "..."}` for everything except `429`
(`{code:"rate_limited", limit, current, key_type:"user"}`).

### Limits

- Excerpt length: ≤120 s.
- `text`: ≤5000 chars.
- `title`: ≤120 chars.
- Daily per-user quota: anon `3`, signed-in `20` (env-tunable). Quota
  is checked AFTER the `video_id` idempotency lookup so client retries
  with the same id don't double-spend.

## Pipeline

1. Download the source MP3 from S3.
2. `ffmpeg -ss/-t -c copy` to cut `[start_ms, end_ms)`.
3. In parallel:
   - List the theme prefix on S3 → SHA256(`video_id`)-seeded
     Fisher-Yates → take `ceil(dur/5)` clips → 4-way parallel download
     → ffmpeg concat-demuxer with `-c copy -an`.
   - Transcribe the cut audio (OpenAI Whisper or Yandex SpeechKit v3,
     selected via `TRANSCRIBER`).
4. Force-align the caller's punctuated text to the recogniser's word
   timings (LCS + interpolation; even-distribution fallback when the
   alignment is implausible).
5. Group aligned words into ≤60-char slides; render one PNG per word
   (NotoSans Bold 53 px, 5 px black outline, gold highlight on the
   current word) plus an optional title card for the first 0.5 s.
6. ffmpeg three-pass: text frames → qtrle .mov (alpha) → composite +
   audio (libx264 veryfast / zerolatency / crf 23 / 30 fps + AAC
   44.1 k stereo) → optional logo append (concat-demuxer stream-copy).
7. Upload the final MP4 to `public/share/video/<video_id>.mp4` with
   `Cache-Control: public, max-age=31536000, immutable`.

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8083` | |
| `DATABASE_URL` | required | Postgres URI for `public.tasks` / `public.usage`. |
| `LECTORIUM_S3_BUCKET` (or `BUCKET`) | required | |
| `LECTORIUM_S3_BACKGROUNDS_PREFIX` | `private/share/video/backgrounds` | |
| `LECTORIUM_S3_VIDEO_PREFIX` | `public/share/video` | |
| `OUTPUT_PUBLIC_BASE` | (unset) | CDN base override for the public URL. |
| `TRANSCRIBE_SCRATCH_PREFIX` | `private/share/video/transcribe-scratch` | SpeechKit only. |
| `AWS_REGION` | `us-east-1` | |
| `S3_ENDPOINT_URL` | (unset) | For S3-compatible (Yandex Object Storage, MinIO). |
| `OPENAI_API_KEY` | required if `TRANSCRIBER=whisper` | |
| `SPEECHKIT_API_KEY` | required if `TRANSCRIBER=speechkit` | |
| `TRANSCRIBER` | `whisper` | `whisper` \| `speechkit`. |
| `JWT_PUBLIC_KEY_PATH` | `/secrets/public.pem` | RS256 public key auth-service emits with. |
| `SHARE_VIDEO_ANON_PER_DAY` | `3` | |
| `SHARE_VIDEO_SIGNED_IN_PER_DAY` | `20` | |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | |
| `FFPROBE_BIN` | `/usr/bin/ffprobe` | |
| `TEMP_ROOT` | `/tmp/render` | |
| `ENV`, `SERVICE_VERSION`, `LOG_LEVEL` | `dev`, `dev`, `info` | Log envelope fields. |

AWS credentials are read from the environment
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

## Worker semantics

- Concurrency 1 per process.
- Tasks polled every 2.5 s from `public.tasks` using
  `SELECT FOR UPDATE SKIP LOCKED`.
- 10-min lease; `ReviveExpired` at boot flips lapsed `running` rows
  back to `pending` (covers crash-mid-render).
- Retries up to the `max_attempts` column default; `Fail` uses a
  background context with a 10 s budget so the UPDATE still goes
  through if the cause was a ctx cancel mid-render.

## Local dev

```bash
docker compose -f infra/app/compose/docker-compose.yml \
               -f infra/app/compose/docker-compose.dev.yml \
               up --build share-video
```
