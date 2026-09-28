# Storage layout

> **Updated docs:** This page is preserved as the original runbook. The infrastructure documentation has been split into a dedicated section with diagrams: see [Infrastructure overview](../infra/README.md), [S3 layout](../infra/s3-layout.md) and [CDN architecture](../infra/cdn.md). The content below remains accurate but the new pages are the recommended entry point.

Shruti content (database, audio, transcripts) is distributed via object storage and fetched by the mobile app at runtime. The app ships with a prebuilt SQLite file inside the APK/IPA (for instant offline first-launch) and fetches fresher content from the CDN in the background.

## Regions

Two regions are seeded in `SERVERS` (`modules/libs/domain/servers.ts`) as `CdnServer` records; once a `config.json` has been fetched, its `regions` block replaces them. The app probes them and picks the first reachable one. Each entry carries the storage `urlTemplate` (where `{path}` is substituted with the storage key) plus the backend service URLs (`shareAudioUrl`, `shareVideoUrl`, `authBaseUrl`, `chatBaseUrl`, and the optional ones).

| ID | Name | `urlTemplate` (CDN reads) |
|---|---|---|
| `global` | Global | `https://cdn.shruti.local/{path}` (the pull zone) |
| `russia` | Russia | `https://ru.shruti.local/{path}` (the regional edge host) |

Both templates read the same store, the Bunny storage zone: `global` through its CDN pull zone, the regional region through its edge host, which forwards `/public/*` to that pull zone. The S3-compatible mirror is filled one way by `storage-sync` on origin.

The other `CdnServer` fields point at the backend. Every service runs on origin: the `global` entry reaches it directly, the `russia` entry through its edge host, which forwards every non-`/public/*` path to origin. The share services (`share-audio`, `share-video`, `share-transcript`) read and write the Bunny storage zone and build every returned URL from their pull-zone public base, so a PDF, excerpt or reel has one URL whichever region the client is on.

## Store layout

Two top-level prefixes inside the storage zone. **The mobile app reads only `public/`**; `artifacts/` is for internal tooling.

```
<zone>/
├── public/                                            ← served anonymously, read-only
│   ├── config.json                                    ← bootstrap manifest
│   ├── db/
│   │   └── shruti.{version}.db                     ← prebuilt SQLite
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
| Content database | `public/db/shruti.{version}.db` | `application/x-sqlite3` |
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

The app picks the highest `version` whose `scheme` matches its built-in scheme (`__DB_SCHEME__`, injected from `modules/db-scheme.json` — currently `20260614`), exact-equality on `scheme` (`findLatestCompatibleVersion`), and downloads the corresponding `.db` file. The manifest is fetched and parsed against the `RemoteAppConfig` shape (`modules/libs/domain/config.ts` — which models only `databases`, `proactive?` and `regions?`); the resolve / probe / scheme-retry / download orchestration lives in the shared kit bootstrap (`modules/kit/src/bootstrap/` — `contentDatabaseResolver.ts`, `bootstrapController.ts`), driven on the mobile side by `modules/apps/mobile/shruti/services/startup.ts` (cold start + background refresh). Only `databases` is storage-related for the resolver: `proactive` drives the proactive-chat scheduler, and `regions` (optionally) replaces the bundled `SERVERS` list via the runtime registry (`modules/apps/mobile/shruti/services/regionsRegistry.ts`). The `library` field is written into the published `config.json` by `library.publish` on the producer side but is **not** part of `RemoteAppConfig` and is not read by the mobile app.

### `public/db/shruti.{version}.db`

SQLite database containing tracks, dictionaries (authors, sources, locations, languages, tags), and per-language variants (titles + audio_path + transcript_path). `{version}` is a timestamp (`YYYYMMDDHHMMSS`). Cached locally under `shruti/databases/shruti.{version}.db`.

Schema is documented in [`../db/`](../db/). Scheme version is encoded in the last row of the `migrations` table.

### `public/tracks/{trackId}/audio/original.mp3`

Original audio recording of the lecture. Streamed by the player via `IAudioPlayer`; optionally cached locally for offline playback via `IMediaDownloader`.

### `public/tracks/{trackId}/transcripts/{language}.json`

Time-aligned transcript blocks for one language of one track. Fetched on demand by `ITranscriptRepository` (HTTP-backed adapter) and cached via `IRemoteFilesStorage`. See [`../architecture/startup-flow.md`](../architecture/startup-flow.md) § 8 for the fetch flow.

## Producers

The **shruti-mcp** pipeline (`modules/tools/shruti-mcp/`, a Go MCP daemon) writes the store. It works out of the `out:` tree (set in `shruti-mcp.yaml`) that mirrors the store one-for-one (`out/public/` + `out/artifacts/`):

- Per-track tools (`track.transcript.create`, `track.transcript.review`, `track.audio.normalize`, `track.audio.tag`, …) stage audio and transcripts under `out/public/tracks/{id}/audio/original.mp3` and `out/public/tracks/{id}/transcripts/{lang}.json`, with pipeline state and raw inputs under `out/artifacts/`.
- `assets.sync` uploads `out/public/` and `out/artifacts/` to the storage zone, file by file against what the store already holds.
- `catalog.publish` is minimal: it bumps the version, uploads `artifacts/catalog/current.db` to the storage zone as `public/db/shruti.{version}.db`, and flips `public/config.json` to advertise it.

The Bunny storage zone is the one write store. The mirror is written only by `storage-sync` on origin (listing-based passes plus the `track.ready` fast path).

## Credentials

- **Read** (runtime, mobile app): no credentials — CDN URLs are public.
- **Write** (shruti-mcp): configured under `s3.bunny` in `shruti-mcp.yaml` (`zone`, `endpoint`, `access_key` — the storage-zone password). The YAML values are `${VAR}`-expanded from a sibling `.env`. Bunny is the only publish target; `cdn.read_base_url` is where the MCP reads published files back anonymously.
