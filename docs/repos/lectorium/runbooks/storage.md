# Storage layout

> **Updated docs:** This page is preserved as the original runbook. The infrastructure documentation has been split into a dedicated section with diagrams: see [Infrastructure overview](../infra/README.md), [S3 layout](../infra/s3-layout.md) and [CDN architecture](../infra/cdn.md). The content below remains accurate but the new pages are the recommended entry point.

Lectorium content (database, audio, transcripts) is distributed via object storage and fetched by the mobile app at runtime. The app ships with a prebuilt SQLite file inside the APK/IPA (for instant offline first-launch) and fetches fresher content from the CDN in the background.

## CDN mirrors

Two CDN endpoints are defined in `SERVERS` (`modules/libs/domain/servers.ts`) as `CdnServer` records. The app probes them and picks the first reachable one. Each entry carries the public bucket `urlTemplate` (where `{path}` is substituted with the storage key) plus the per-region backend service URLs (`shareAudioUrl`, `shareVideoUrl`, `authBaseUrl`, `chatBaseUrl`).

| ID | Name | `urlTemplate` (CDN reads) |
|---|---|---|
| `global` | Global | `https://akds-lectorium.s3.us-east-1.amazonaws.com/{path}` |
| `russia` | Russia | `https://akds-lectorium.storage.yandexcloud.net/{path}` |

The `urlTemplate` is the public S3 bucket the mobile client streams lecture audio and downloads the SQLite DB from directly (AWS S3 `us-east-1` for `global`, Yandex Object Storage for `russia`). The Russia bucket is synced from AWS via rclone in `.github/workflows/storage-sync.yml`.

The other `CdnServer` fields point at the self-hosted backend containers and are unrelated to object-storage reads. The `global` entry resolves them to the global origin (`api.shruti.local`); the `russia` entry resolves them to the RU origin (`62-109-31-177.sslip.io`). All three share-* services (`share-audio`, `share-video`, `share-transcript`) plus `postgres`/`redis` run under **both** the `origin` and `proxy` compose profiles (`infra/app/compose/docker-compose.yml`), so a Russia VPS runs them locally and uploads excerpts/reels/PDFs to the Yandex bucket — RU users hit RU containers end-to-end on data-resident storage. `chat`, `auth`, `cleanup-worker`, and `search-mcp` are `origin`-only; on a proxy host Caddy reverse-proxies `/auth` and `/chat` upstream to the global origin.

> **share-transcript RU deploy note.** Because share-transcript runs on the RU host too, it renders close to the Yandex bucket the PDF lands in. That makes `LECTORIUM_S3_PUBLIC_BASE` (or `PDFS_PUBLIC_BASE`) mandatory on the RU host: the service builds the returned PDF URL from it, and the mobile warm-cache probe (Yandex `urlTemplate`) only hits if the two match. The service **fails to boot** (`RuntimeError` in `modules/services/share-transcript/app/src/share_transcript/config.py`) if `S3_ENDPOINT_URL` is set without a public base — a deliberate guard against silently emitting AWS URLs for Yandex objects. Set `LECTORIUM_S3_PUBLIC_BASE=https://akds-lectorium.storage.yandexcloud.net` on RU.

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
│           │   ├── original.mp3                        ← canonical audio per track
│           │   └── clean.mp3                           ← optional denoised variant (kind=clean)
│           └── transcripts/
│               └── {language}.json                     ← reviewed transcript per language
└── artifacts/                                          ← NOT read by the mobile app
    ├── catalog/                                        ← current.db + meta.json (sidecar)
    ├── lake/index.db                                   ← path → trackId + per-stage pipeline state (runs.db sits alongside)
    └── tracks/{id}/
        ├── audio/source.mp3                            ← raw source recording
        ├── transcript.pdf                              ← aligned-PDF input
        ├── meta.json                                   ← extracted-metadata sidecar
        ├── outline/{lang}/granular.json               ← outline working set
        └── transcripts/{lang}/                         ← raw.json, review.json, chunk_{NNNN}.json
```

Public audio is stored per kind at `public/tracks/{id}/audio/{kind}.mp3`; `original` is the canonical one every track has, and `clean` is an optional denoiser output. Public transcripts are the single reviewed `{language}.json`; the raw/review/chunk working files stay under `artifacts/`.

All keys are anonymous `GET` — no signed URLs. CORS must be enabled on the bucket to allow `GET *` for browser (web) builds.

## Path convention

**SQLite rows store full paths from the bucket root**, including the `public/` prefix. Audio and transcript paths live on the per-language **`track_variants`** table (`track_variants.audio_path`, `track_variants.transcript_path`), with extra audio kinds (e.g. denoised `clean`) in the **`track_audio`** table — not on `tracks` itself. For example, `track_variants.audio_path = "public/tracks/abc123/audio/original.mp3"`. The client never concatenates prefixes — `IStoragePublicUrl.get(path)` (port re-exported at `modules/apps/mobile/ports/app/storagePublicUrl.ts`, implemented in the shared kit at `modules/kit/src/infra/storagePublicUrl/useStoragePublicUrl.ts`) delegates to `buildServerUrl(server, path)`, which substitutes `{path}` in the active server's `urlTemplate`. The active server is read lazily on each call, so a region flip routes reads to the new bucket without re-creating the resolver. This keeps the resolver one-step and avoids classes of bugs around mis-concatenated paths.

## Asset reference

| Asset | Key pattern | Content-Type |
|---|---|---|
| Remote config | `public/config.json` | `application/json` |
| Content database | `public/db/lectorium.{version}.db` | `application/x-sqlite3` |
| Track audio | `public/tracks/{trackId}/audio/{kind}.mp3` (`original`, optional `clean`) | `audio/mpeg` |
| Transcript | `public/tracks/{trackId}/transcripts/{language}.json` | `application/json` |

### `public/config.json`

Bootstrap manifest fetched on every cold start / background refresh.

```json
{
  "databases": [
    { "version": 20260419120000, "scheme": 20260419 }
  ],
  "regions": [ /* optional CdnServer list — replaces bundled SERVERS */ ],
  "proactive": { /* optional agent proactive config */ },
  "library": { /* written by library.publish; not consumed by the mobile app */ }
}
```

The app picks the highest `version` whose `scheme` matches its built-in scheme (`__DB_SCHEME__`, injected from `modules/db-scheme.json` — currently `20260614`), exact-equality on `scheme` (`findLatestCompatibleVersion`), and downloads the corresponding `.db` file. The manifest is fetched and parsed against the `RemoteAppConfig` shape (`modules/libs/domain/config.ts` — which models only `databases`, `proactive?` and `regions?`); the resolve / probe / scheme-retry / download orchestration lives in the shared kit bootstrap (`modules/kit/src/bootstrap/` — `contentDatabaseResolver.ts`, `bootstrapController.ts`), driven on the mobile side by `modules/apps/mobile/lectorium/views/Welcome/WelcomeView.controller.ts` (cold start + background refresh). Only `databases` is storage-related for the resolver: `proactive` drives the proactive-chat scheduler, and `regions` (optionally) replaces the bundled `SERVERS` list via the runtime registry (`modules/apps/mobile/lectorium/services/regionsRegistry.ts`). The `library` field is written into the published `config.json` by `library.publish` on the producer side but is **not** part of `RemoteAppConfig` and is not read by the mobile app.

### `public/db/lectorium.{version}.db`

SQLite database containing tracks, dictionaries (authors, sources, locations, languages, tags), and per-language variants (titles + audio_path + transcript_path). `{version}` is a timestamp (`YYYYMMDDHHMMSS`). Cached locally under `lectorium/databases/lectorium.{version}.db`.

Schema is documented in [`../db/`](../db/). Scheme version is encoded in the last row of the `migrations` table.

### `public/tracks/{trackId}/audio/original.mp3`

Original audio recording of the lecture. Streamed by the player via `IAudioPlayer`; optionally cached locally for offline playback via `IMediaDownloader`.

### `public/tracks/{trackId}/transcripts/{language}.json`

Time-aligned transcript blocks for one language of one track. Fetched on demand by `ITranscriptRepository` (HTTP-backed adapter) and cached via `IRemoteFilesStorage`. See [`../architecture/startup-flow.md`](../architecture/startup-flow.md) § 8 for the fetch flow.

## Producers

The **lectorium-mcp** pipeline (`modules/tools/lectorium-mcp/`, a Go MCP daemon) writes the bucket. It works out of the `out:` tree (set in `lectorium-mcp.yaml`) that mirrors the bucket one-for-one (`out/public/` + `out/artifacts/`):

- Per-track tools (`track.transcript.create`, `track.transcript.review`, `track.audio.normalize`, `track.audio.tag`, …) stage audio and transcripts under `out/public/tracks/{id}/audio/original.mp3` and `out/public/tracks/{id}/transcripts/{lang}.json`, with pipeline state and raw inputs under `out/artifacts/`.
- `catalog.publish` is minimal: it bumps the version, uploads `artifacts/catalog/current.db` to S3 as `public/db/lectorium.{version}.db`, and flips `public/config.json` to advertise it. Asset files (audio, transcripts, images) are **not** swept up by publish — each pipeline pushes its own artifacts. A full one-shot upload is `aws s3 sync out/ s3://akds-lectorium/`.

The AWS bucket is the source of truth. The MCP can mirror writes to Yandex directly when the `S3_YANDEX_*` config is set; otherwise the Russia bucket's `public/` prefix is kept in sync externally via the rclone workflow (`.github/workflows/storage-sync.yml`, `rclone sync aws:…/public/ → yandex:…/public/`).

## Credentials

- **Read** (runtime, mobile app): no credentials — CDN URLs are public.
- **Write** (lectorium-mcp): configured under the `s3:` block in `lectorium-mcp.yaml` (nested `s3.aws.*` / `s3.yandex.*` keys: `bucket`, `region`, `endpoint`, `access_key_id`, `secret_access_key`). The YAML values are `${VAR}`-expanded from a sibling `.env`. Both targets share one uploader (`internal/infra/s3/aws/uploader.go`): if `access_key_id` **and** `secret_access_key` are set, static credentials are used; if either is empty, the AWS SDK default credential chain (env / shared config / SSO / IMDS) is used instead — the right path for `aws sso login` workflows. Defaults: AWS bucket `akds-lectorium`, region `us-east-1`; Yandex region `ru-central1`, endpoint `https://storage.yandexcloud.net`. The Yandex mirror is optional (leave its `bucket` unset to skip). Note the code does **not** special-case Yandex — leaving its keys empty also falls back to the default chain, but since that chain resolves AWS credentials (not Yandex), an explicit `access_key_id`/`secret_access_key` is required for the Yandex target to actually authenticate.
