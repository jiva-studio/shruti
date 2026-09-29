# Storage layout

Shruti content is written to one store, the Bunny storage zone, and served through its CDN pull zone; an S3-compatible mirror holds a copy that only `storage-sync` writes, one way. The mobile app reads through the pull zone, directly or through a regional edge host; [`shruti-mcp`](../runbooks/shruti-mcp.md) (the content pipeline + producer) builds an `out/` tree on a developer machine that mirrors the store — `out/public/` is what the app reads, `out/artifacts/` carries the internal-only per-track artifacts (raw transcripts, source mp3, granular outline, extracted metadata) that ride the same store under the `artifacts/` prefix — and uploads it to the storage zone. This page documents what's in the store, where, and how it gets there.

## Store structure

```mermaid
graph TD
    BKT[("storage zone")]
    BKT --> PUB[("public/<br/>read by the app, anonymous GET")]
    BKT --> ART[("artifacts/<br/>internal-only — app never reads<br/>raw transcripts, source.mp3,<br/>granular outline, meta")]
    BKT --> PRV[("private/<br/>internal-only<br/>share-video backgrounds + scratch")]

    PUB --> CFG["config.json<br/>application/json<br/>{ databases, library, regions, proactive }"]
    PUB --> DBDIR[("db/")]
    PUB --> LIBDIR[("library/")]
    PUB --> TRDIR[("tracks/")]
    PUB --> SHDIR[("shares/audio/ &amp; share/video/")]

    DBDIR --> DBFILE["shruti.{version}.db<br/>application/x-sqlite3"]
    LIBDIR --> LIBFILE["library.{version}.db<br/>application/x-sqlite3"]

    TRDIR --> TID[("{trackId}/")]
    TID --> AUDIO[("audio/")]
    TID --> TRX[("transcripts/")]
    AUDIO --> MP3["original.mp3<br/>audio/mpeg"]
    TRX --> TJSON["{language}.json<br/>application/json"]

    SHDIR --> EXC["{id}.mp3 / {id}.mp4<br/>audio/mpeg · video/mp4"]

    classDef rdir fill:#a6e3a1,stroke:#6c7086,color:#1e1e2e;
    classDef rfile fill:#89dceb,stroke:#6c7086,color:#1e1e2e;
    classDef internal fill:#f38ba8,stroke:#6c7086,color:#1e1e2e;
    class BKT,PUB,DBDIR,LIBDIR,TRDIR,TID,AUDIO,TRX,SHDIR rdir;
    class CFG,DBFILE,LIBFILE,MP3,TJSON,EXC rfile;
    class ART,PRV internal;
```

## Key reference

| Asset | Key pattern | Content-Type | Producer |
|---|---|---|---|
| Remote config | `public/config.json` | `application/json` | `catalog.publish` / `library.publish` / `catalog.config.publish` |
| Content database | `public/db/shruti.{version}.db` | `application/x-sqlite3` | `catalog.publish` |
| Library database | `public/library/library.{version}.db` | `application/x-sqlite3` | `library.publish` |
| Track audio | `public/tracks/{trackId}/audio/original.mp3` | `audio/mpeg` | pipeline (`assets.sync`) |
| Transcript | `public/tracks/{trackId}/transcripts/{language}.json` | `application/json` | pipeline (`assets.sync`) |
| Shared audio excerpt | `public/shares/audio/{excerptId}.mp3` | `audio/mpeg` | [share-audio](../modules/share-audio.md) service |
| Shared video reel | `public/share/video/{videoId}.mp4` | `video/mp4` | share-video service |
| Transcript PDF export | `public/tracks/{trackId}/exports/{language}.pdf` | `application/pdf` | [share-transcript](../modules/share-transcript.md) service (rendered on demand; the renderer version sits in a sidecar object `{language}.pdf.version`) |
| Per-track internal artifacts (text) | `artifacts/tracks/{trackId}/...` (e.g. `transcripts/{language}/raw.json`, `outline/{language}/granular.json`, `meta.json`) | per-file (JSON) | pipeline (`fsartifact.Writer` writes locally, `assets.sync` uploads; app never reads) |
| Per-track source audio | `artifacts/tracks/{trackId}/audio/source.mp3` | `audio/mpeg` | pipeline (`assets.sync`; written locally by `audiostore`, not by `fsartifact.Writer`) |

`{version}` is a 14-digit timestamp `YYYYMMDDHHMMSS` (e.g. `20260419120000`) generated at publish time from `time.Now().UTC()` — lexicographic sort = chronological order. If a fresh timestamp collides with an entry already in `config.json`, the publisher bumps it to `max(existing)+1`, so versions are strictly monotone per ladder. `{trackId}` is the prefixed nanoid (e.g. `track_aBC1234567890`) — see [ID generation](../db/ids.md). `{language}` is an ISO-639 code (`ru`, `en`, `hi`).

Content types are passed explicitly to each `Uploader.Put(ctx, key, contentType, body, size)` call — there is no extension→MIME lookup table. The `.db` and `config.json` content types are hard-coded in the publish use cases; the audio/transcript/share content types are set by whatever produces those files.

## Path convention

**SQLite rows store full paths from the bucket root**, including the `public/` prefix. The client never concatenates prefixes. The commit use case writes them this way (`modules/tools/shruti-mcp/internal/application/commit/setmetadata.go`):

```
tracks.audio_path        = "public/tracks/track_aBC1234567890/audio/original.mp3"
tracks.transcript_path   = "public/tracks/track_aBC1234567890/transcripts/ru.json"
```

`IStoragePublicUrl.get(path)` simply substitutes the path into the active CDN server's `urlTemplate` (a `{path}` placeholder):

```ts
// modules/kit/src/infra/storagePublicUrl/useStoragePublicUrl.ts
export function useStoragePublicUrl(
  getActiveServer: () => Pick<CdnServer, "urlTemplate">
): IStoragePublicUrl {
  return { get: (path: string) => buildServerUrl(getActiveServer(), path) }
}

// modules/kit/src/servers/cdnServer.ts
export function buildServerUrl(server: Pick<CdnServer, "urlTemplate">, path: string): string {
  return server.urlTemplate.replace("{path}", path)
}
```

The active server is read lazily on each call, so the resolver always reflects the current region selection without being re-created. This single-step substitution is the whole reason paths are stored fully-qualified — it eliminates a class of bugs around mis-joined prefixes.

## `public/config.json`

Bootstrap manifest fetched on every cold start and on every background refresh. It carries four independent top-level keys, each owned by a different publisher / use case:

```json
{
  "databases": [
    { "version": 20260419120000, "scheme": 20260419 },
    { "version": 20260411211018, "scheme": 20260411 }
  ],
  "library": {
    "versions": [
      { "version": 20260415090000 }
    ]
  },
  "regions": [
    {
      "id": "global",
      "name": "Global",
      "urlTemplate": "https://cdn.shruti.local/{path}",
      "shareAudioUrl": "…", "shareVideoUrl": "…",
      "authBaseUrl": "…", "chatBaseUrl": "…"
    }
  ],
  "proactive": { }
}
```

- `databases` — written by `catalog.publish`. Each entry is `{version, scheme}`. The list is deduped on `version`, the new version is prepended, and the whole list is sorted newest-first. **Every** previously-published version is kept (no top-N truncation): a client pinned to an older scheme must keep finding its compatible DB; stale blobs are only ever pruned by a separate scheme-aware retention pass. The app filters by `db.scheme === SUPPORTED_DB_SCHEME` (the build-time `__DB_SCHEME__` constant from `modules/db-scheme.json`) and picks the max surviving `version`.
- `library` — written by `library.publish`. A `{versions: [{version}]}` block, same dedup / prepend / newest-first / keep-every-version policy. Tracks the canonical-corpus DB ladder, which moves on a slower cadence than the track catalog.
- `regions` — written by `catalog.publish` and `catalog.config.publish` from the local config's `regions` section. The list of CDN/region endpoints the app downloads on startup; each entry mirrors the mobile `CdnServer` shape one-to-one (`{id, name, urlTemplate, shareAudioUrl, shareVideoUrl, authBaseUrl, chatBaseUrl}` plus the optional `shareTranscriptUrl`, `profileBaseUrl`, `orchestratorBaseUrl`, `discoveryBaseUrl`); a key the tool does not model is carried through untouched. Edited via the `catalog.config.regions.*` tools (`modules/tools/shruti-mcp/internal/application/catalog/regions/usecase.go`); absent locally → left untouched in the store (never cleared, which would strand clients).
- `proactive` — written by `catalog.publish` and `catalog.config.publish` from the local config's `proactive` section. Absence reverts clients to bundled proactive defaults.

The source-of-truth for the human-edited sections (`regions`, `proactive`) is the local `<out>/artifacts/catalog/config.json` (package `configdoc`, `modules/tools/shruti-mcp/internal/application/catalog/configdoc/store.go`). Each publisher reads the published `config.json` into a `map[string]json.RawMessage`, edits only its own keys, and writes the rest back untouched — so catalog, library, and config-only publishes never clobber each other's sections. `catalog.config.publish` is the "config only" path: it re-ships just `regions` + `proactive` without touching the DB ladder or bumping a version.

## `public/db/shruti.{version}.db`

The prebuilt SQLite content database. Schema is in [`../db/`](../db/). `catalog.publish` uploads `out/artifacts/catalog/current.db` to this versioned key in the storage zone, then flips `config.json` to advertise it; the DB is uploaded before the config flip so a partial failure leaves the previous version still live. Cached on-device under `shruti/databases/shruti.{version}.db`.

The current scheme is read on-device by:

```sql
SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1;
```

Mismatch with the build-time `__DB_SCHEME__` constant rejects the file and triggers a re-download (see [startup-flow § 6](../architecture/startup-flow.md#6-validate--open--confirm-the-scheme)).

## `public/library/library.{version}.db`

The canonical-corpus DB (verses, documents, translations, attributions). `library.publish` ships `out/artifacts/library/library.db` here and merges a `library` entry into `config.json`. Published independently of the track catalog because the underlying corpus changes rarely (new translation source, re-import).

## `public/tracks/{trackId}/audio/original.mp3`

Original audio recording, normalized and ID3-tagged by the pipeline (`track.audio.normalize`, `track.audio.tag`) into `out/public/tracks/{id}/audio/original.mp3`. Streamed by the player via `IAudioPlayer`; optionally cached locally for offline playback by `IMediaDownloader` (see [`MediaItem`](../domain/entities.md#mediaitem--mediaitemts)).

## `public/tracks/{trackId}/transcripts/{language}.json`

Time-aligned transcript blocks for one (track, language), produced by the transcript pipeline (`track.transcript.create` / `track.transcript.review`) into `out/public/tracks/{id}/transcripts/{lang}.json`. Fetched on demand by `ITranscriptRepository` (HTTP-backed adapter), cached locally via `IRemoteFilesStorage`. The fetch flow is in [`flows/transcript-load.md`](../architecture/flows/transcript-load.md).

> Transcripts are **not stored in SQLite** — only the path to them is. Keeping the JSON out of the DB keeps the prebuilt file small and lets transcripts be republished without a new DB version.

## `public/shares/audio/`, `public/share/video/` and PDF exports

Runtime-generated share assets, written directly to the storage zone through its HTTP API by the share services on origin (not part of the `out/` build tree):

- [share-audio](../modules/share-audio.md) cuts an MP3 fragment from a `source_key` (e.g. `public/tracks/{id}/audio/original.mp3`, range-read through the pull zone) and uploads `public/shares/audio/{excerptId}.mp3` (`audio/mpeg`). Idempotent on `excerptId`. Default prefix `EXCERPTS_PREFIX=public/shares/audio`.
- share-video downloads the source through the storage API, lists `private/share/video/backgrounds/<theme>/` (one directory level, `.mp4` files), renders a captioned reel and uploads `public/share/video/{videoId}.mp4` (`video/mp4`). Default prefix `SHRUTI_S3_VIDEO_PREFIX=public/share/video`.
- [share-transcript](../modules/share-transcript.md) reads the transcript JSON and writes `public/tracks/{id}/exports/{lang}.pdf`, then the sidecar `{lang}.pdf.version` holding the renderer version. The storage API carries no custom object metadata, so the sidecar is what tells a current PDF from a stale one.

## Producer pipeline

The producer is `shruti-mcp`. It builds an `out/` tree that mirrors the store — `out/public/` is what the app reads; `out/artifacts/` holds internal-only content. The per-track **text** artifacts (raw/review transcripts, granular outline, `meta.json`) are written locally through `fsartifact.Writer` (`modules/tools/shruti-mcp/internal/infra/artifact/fs/writer.go`) as they're produced. The per-track binary `source.mp3` is written locally by `audiostore`, and `out/artifacts/catalog/current.db` / `out/artifacts/library/library.db` are producer-local until a publish step versions them. `assets.sync` uploads `out/public/` (audio `original.mp3`, `{lang}.json` transcripts) and `out/artifacts/` to the storage zone, deciding per file against the store, so an interrupted run resumes where it stopped. The three `*.publish` use cases handle only the versioned `.db` files and the `config.json` pointer flip. The mirror is never written by the MCP; `storage-sync` on origin copies every change to it.

```mermaid
sequenceDiagram
    autonumber
    participant Lake as Lake (incoming mp3s)
    participant MCP as shruti-mcp
    participant Zone as Bunny storage zone
    participant Sync as storage-sync (origin)
    participant Mirror as S3-compatible mirror

    Note over MCP: pipeline (ingest → ... → commit)
    MCP->>Lake: scan in: tree, ingest tracks (source.mp3 → out/artifacts/tracks/{id}/audio/)
    MCP->>MCP: normalize + tag audio → out/public/tracks/{id}/audio/original.mp3
    MCP->>MCP: per-track text artifacts → out/artifacts/tracks/{id}/... (fsartifact.Writer)
    MCP->>MCP: transcribe + review → out/public/tracks/{id}/transcripts/{lang}.json
    MCP->>MCP: commit → catalog rows in out/artifacts/catalog/current.db

    Note over MCP: asset upload
    MCP->>Zone: assets.sync (public audio, transcripts + artifacts)

    Note over MCP: catalog.publish
    MCP->>Zone: PUT public/db/shruti.{version}.db
    MCP->>Zone: GET + merge databases + regions + proactive + PUT public/config.json

    Note over MCP: library.publish (independent cadence)
    MCP->>Zone: PUT public/library/library.{version}.db
    MCP->>Zone: GET + merge library + PUT public/config.json

    Note over MCP: catalog.config.publish (config only, no DB)
    MCP->>Zone: GET + overwrite regions + proactive + PUT public/config.json

    Note over Sync: every pass, plus track.ready
    Sync->>Zone: list
    Sync->>Mirror: copy what differs
```

The publish use cases are part of the MCP tool surface — see the project conventions for the `catalog.publish` / `library.publish` / `catalog.config.publish` envelopes. The two DB publishers upload the DB first, then flip `config.json`, so no client ever sees a config pointing at a missing `.db`.

> The Bunny storage zone is the one write store; `global` reads it through the CDN pull zone (`urlTemplate` `https://cdn.shruti.local/{path}`), the regional region through its edge host (`urlTemplate` `<regional-host>/{path}`, whose `/public/*` goes to the same pull zone). Both region seeds ship in `modules/libs/domain/servers.ts` and are replaced by the `regions` section of `config.json` once it has been fetched.

## Credentials

| Direction | Caller | Auth |
|---|---|---|
| Read | Mobile app at runtime | None — anonymous `GET public/*` through the pull zone; `artifacts/` and `private/` are not publicly readable |
| Write — publish | `shruti-mcp` | The storage-zone password, configured under `s3.bunny` in `shruti-mcp.yaml` |
| Write — shares | share-audio / share-video / share-transcript on origin | The storage-zone password (`STORAGE_ZONE` / `STORAGE_KEY`). share-audio reads `public/tracks/` (gated to `SOURCE_KEY_PREFIX=public/tracks/`) and writes `public/shares/audio/`; share-video reads `public/tracks/` and `private/share/video/backgrounds/`, and writes `public/share/video/`; share-transcript reads `public/tracks/…/transcripts/` and writes `public/tracks/…/exports/` |
| Write — mirror | `storage-sync` on origin | The mirror's own access keys; no other process holds them |
