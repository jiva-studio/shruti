# Storage layout

Lectorium content (database, audio, transcripts) is distributed via object storage and fetched by the mobile app at runtime. The app ships with a prebuilt SQLite file inside the APK/IPA (for instant offline first-launch) and fetches fresher content from the CDN in the background.

## CDN mirrors

Two CDN endpoints are defined in `SERVERS` (`modules/libs/domain/servers.ts`). The app probes them and picks the first reachable one. The `{path}` placeholder is substituted with the storage key.

| ID | Name | URL template |
|---|---|---|
| `global` | AWS (global) | `https://akds-lectorium.s3.us-east-1.amazonaws.com/{path}` |
| `russia` | Yandex (RU) | `https://akds-lectorium.storage.yandexcloud.net/{path}` |

The Russia mirror is synced from AWS via rclone (see `.github/workflows/storage-sync.yml` if present).

## Bucket layout

Two top-level prefixes inside the bucket. **The mobile app reads only `public/`**; `artifacts/` is for internal tooling.

```
akds-lectorium/
├── public/                                            ← served anonymously, read-only
│   ├── config.json                                    ← bootstrap manifest
│   ├── db/
│   │   └── lectorium.{version}.db                     ← prebuilt SQLite
│   └── tracks/
│       └── {trackId}/
│           ├── audio/
│           │   └── original.mp3                        ← audio file per track
│           └── transcripts/
│               └── {language}.json                     ← transcript per language
└── artifacts/                                          ← NOT read by the mobile app
    └── …                                               ← internal tooling output
```

All keys are anonymous `GET` — no signed URLs. CORS must be enabled on the bucket to allow `GET *` for browser (web) builds.

## Path convention

**SQLite rows store full paths from the bucket root**, including the `public/` prefix. For example, `tracks.audio_path = "public/tracks/abc123/audio/original.mp3"`. The client never concatenates prefixes — `IStoragePublicUrl.get(path)` simply substitutes `{path}` in the active server template. This keeps the resolver one-step and avoids classes of bugs around mis-concatenated paths.

## Asset reference

| Asset | Key pattern | Content-Type |
|---|---|---|
| Remote config | `public/config.json` | `application/json` |
| Content database | `public/db/lectorium.{version}.db` | `application/x-sqlite3` |
| Track audio | `public/tracks/{trackId}/audio/original.mp3` | `audio/mpeg` |
| Transcript | `public/tracks/{trackId}/transcripts/{language}.json` | `application/json` |

### `public/config.json`

Bootstrap manifest fetched on every cold start / background refresh.

```json
{
  "databases": [
    { "version": 20260419120000, "scheme": 20260419 }
  ]
}
```

The app picks the highest `version` compatible with its current scheme and downloads the corresponding `.db` file. Fetched by `resolveContentDatabase.ts` and `checkForUpdatesInBackground.ts`.

### `public/db/lectorium.{version}.db`

SQLite database containing tracks, dictionaries (authors, sources, locations, languages, tags), and per-language variants (titles + audio_path + transcript_path). `{version}` is a timestamp (`YYYYMMDDHHMMSS`). Cached locally under `lectorium/databases/lectorium.{version}.db`.

Schema is documented in `docs/db/scheme.*.md`. Scheme version is encoded in the last row of the `migrations` table.

### `public/tracks/{trackId}/audio/original.mp3`

Original audio recording of the lecture. Streamed by the player via `IAudioPlayer`; optionally cached locally for offline playback via `IMediaDownloader`.

### `public/tracks/{trackId}/transcripts/{language}.json`

Time-aligned transcript blocks for one language of one track. Fetched on demand by `ITranscriptRepository` (HTTP-backed adapter) and cached via `IRemoteFilesStorage`. See `docs/architecture/startup-flow.md` § 8 for the fetch flow.

## Producers

Only the **content-db-builder** (`modules/tools/content-db-builder/`) writes to the bucket:

- `src/buildDb.ts` — builds the prebuilt SQLite file from CouchDB sources.
- `src/exportTranscripts.ts` — exports transcripts from CouchDB as per-track-per-language JSON files.
- `src/uploadToS3.ts` — uploads `.db` + transcripts to AWS, updates `config.json`.

The AWS bucket is the source of truth. The Yandex bucket is a passive mirror.

## Credentials

- **Read** (runtime, mobile app): no credentials — CDN URLs are public.
- **Write** (content-db-builder CLI): AWS + optional Yandex keys via environment variables (`S3_AWS_ACCESS_KEY_ID`, `S3_AWS_SECRET_ACCESS_KEY`, `S3_YANDEX_ACCESS_KEY_ID`, `S3_YANDEX_SECRET_ACCESS_KEY`).
