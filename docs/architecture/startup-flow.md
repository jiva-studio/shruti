# Shruti app startup flow

This document describes what happens from `main.ts` to the first time the
content database answers a query: how CDN servers are probed, the remote
config is fetched, which database is downloaded and opened (or recovered
from a previous launch), and where each resource lives.

Formal specs referenced from here:
- **DB scheme** — see `docs/db/scheme.*.md` (the latest file)
- **Storage layout** — [`../storage.md`](../storage.md)

## 1. Overview

```
main.ts
  └─ initShruti(config)                       [modules/apps/mobile/shruti/shruti.ts]
      └─ create platform-specific persistence / fetcher / filesStorage / databaseTransfer
  └─ Mount Vue app → router ready
  └─ Welcome view                                [views/Welcome/WelcomeView.controller.ts]
      Phase 1 — resolve content database         [composables/resolveContentDatabase.ts]
        1a. scan local FS for a cached DB        (database:check)
        1b. if missing — probe CDN servers      (server:probing)
            download config.json                 (config:downloading)
            download DB                          (database:downloading)
      Phase 2 — validate scheme, drop if stale   [composables/openAndValidateContentDatabase.ts]
      Phase 3 — bootstrap user DB + stores       (database:migrations)
            open user.db, run migrations, load config / debug stores
            router.replace('/tabs/home')
      Fire-and-forget — check for newer DB       [composables/checkForUpdatesInBackground.ts]
```

## 2. Entry point & bootstrap

- `modules/apps/mobile/shruti/main.ts` — creates Vue + Ionic, waits for router,
  calls `initShruti(config)` before mounting.
- `modules/apps/mobile/shruti/shruti.ts` — `initShruti(config)` assembles a
  singleton with platform‑specific implementations:
  - Persistence: `useCapacitorSqlPersistence()` (native, `@capacitor-community/sqlite`)
    or `useSqlJsPersistence()` (web, `sql.js`).
  - DB fetcher: `useDatabaseToFsFetcher()` (native, `@capacitor/file-transfer`)
    or `useDatabaseToIndexedDbFetcher()` (web, `fetch` + IndexedDB `saveBlob`).
    Both implement `IDatabaseFetcher.list(directory)` — native returns cached
    file names, web returns `[]` (IDB has no filesystem semantics).
  - FilesStorage: `useCapacitorRemoteFilesStorage({ cacheDir: "shruti" })`
    or `useWebRemoteFilesStorage({ cacheName: "shruti" })`.
  - DatabaseTransfer: `useCapacitorDatabaseTransfer(...)` or
    `useWebDatabaseTransfer(...)`.
  - `useStoragePublicUrl(template)` — active CDN server's URL template,
    swapped in by the server probe (see Phase 1b).

## 3. Remote storage

All downloadable artefacts are served from a multi-CDN pool defined in
`@lib/domain/servers`. The app probes each server and picks the fastest
responder at startup (and again on each Welcome pass / background refresh).

- **Artefacts** — same bucket layout everywhere:
  - `/public/config.json`
  - `/public/db/shruti.{version}.db`
  - `/public/tracks/{trackId}/audio/original.mp3`
  - `/public/tracks/{trackId}/transcripts/{language}.json`
- **Active server** — stored in `shruti.activeServer`; preferred id
  persisted via `IPreferences` (`preferredServerId`) so the same server
  is tried first on the next launch.
- **Resolver** — `storagePublicUrl.get(path)` substitutes `{path}` in the
  active server's template. SQLite rows store **full paths from the bucket
  root** (including the `public/` prefix) — no concatenation in use cases.

See [`../storage.md`](../storage.md) for the canonical server list.

## 4. Phase 1 — resolve content database

Driven by `composables/resolveContentDatabase.ts` with deps injected
from the controller.

### 1a. Local FS scan (offline first)

`findLocalDatabase(deps, incompatibleDbPaths)`:

1. Derive the parent directory from `localPathTemplate` (e.g.
   `shruti/databases`).
2. `databaseFetcher.list(parentDir)` — on native this is
   `Filesystem.readdir`; on web it returns `[]`.
3. Keep only `shruti.*.db` file names not present in the in-memory
   `incompatibleDbPaths` set (see Phase 2).
4. Pick the lexicographically largest (= latest timestamp-based version).
5. Return its storage path, or `null` when nothing qualifies.

When a path is returned the flow skips straight to Phase 2 — **no network
is touched**. This keeps the app fast on warm launches and lets the app
recover from a stale-DB crash loop by simply relaunching with whatever
cached DB is on disk. On web, step 2 always yields `[]` so web falls
through to 1b.

The prebuilt DB is pre-copied into the app's writable directory at first
launch by `BundledDatabaseHelper` (Android/iOS native code) reading the
file shipped in `assets/databases/` (Android) or `App.bundle/databases/`
(iOS). So even the very first launch without network finds a DB in 1a.

### 1b. CDN fetch (cold launch / no local copy)

`fetchDatabaseFromCdn(deps)`:

1. Probe servers — `probeServers(configPath, preferredServerId)`
   (state: `server:probing`). Winner becomes the active server.
2. Resolve the latest version from the probe's cached `config.json`
   (state: `config:downloading`). Filters `config.databases` by
   `(db.scheme ?? 1) === SUPPORTED_DB_SCHEME` and picks the max
   `version`. If the cached config lists nothing compatible, the
   filesStorage cache for `config.json` is invalidated and the config
   is re-fetched once.
3. If `databaseFetcher.exists(localPath)` is `false`, download with
   progress (state: `database:downloading`). Otherwise reuse the cached
   file.

Returns the local storage path to Phase 2.

## 5. Phase 2 — open & validate the content database

`composables/openAndValidateContentDatabase.ts` opens the file, reads the
scheme via `SchemeVersionRepository` (which runs
`SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1`
and returns `0` on missing table), and either accepts it (`0` = legacy, or
matches `SUPPORTED_DB_SCHEME` — injected at build time from
`modules/db-scheme.json` via Vite `define` as `__DB_SCHEME__`) or:

1. Closes the DB.
2. Adds the path to an in-memory `incompatibleDbPaths` set so
   `findLocalDatabase` won't pick it again this session.
3. Hard caps the set at `MAX_SCHEME_RETRIES` (3) — beyond that the
   error surfaces to the Welcome error screen.
4. Deletes the local file (`databaseFetcher.delete`).
5. Invalidates the cached `config.json` so the next pass re-probes.
6. Retries `initialize()` — loops back to Phase 1.

This ensures that a stale bundled DB (or one whose scheme disagrees with
what config advertises) can't wedge the app.

## 6. Phase 3 — bootstrap user DB + stores

After the content DB is confirmed compatible:

1. Open user DB at a fixed path (`user.db` on native, `shruti/databases/user.db`
   on web-IDB — this is an implementation detail of the persistence adapter).
2. `runUserMigrations(userDb)` applies any pending code migrations
   sequentially (tracked in the `migrations` table) and calls
   `db.save()` at the end.
3. Load `useConfigStore`, `useDebugStore`.
4. Transition to `complete` and `router.replace('/tabs/home')`.

Migration files live in
`modules/apps/mobile/shruti/services/migrations/user/` (individual
`.ts` files per migration, plus a barrel). The user DB's shape is fully
described by the migration history — there is no external schema doc.

## 7. Post-bootstrap — background refresh

Fire-and-forget from `initialize()` after Phase 3 completes:
`composables/checkForUpdatesInBackground.ts`.

1. Probe servers (same logic as Phase 1b).
2. If the latest advertised version is already cached
   (`databaseFetcher.exists`), stop.
3. Otherwise download the newer DB alongside the currently-open one.
   The file will be picked up on the next launch by `findLocalDatabase`
   (lexicographic sort).
4. Persist the probed server id via `IPreferences` if it changed.

All errors are swallowed — the app works fine with yesterday's DB.

## 8. Transcript fetching

Transcripts are **not** stored in the SQLite content DB — they are public
JSON files on S3. `ITranscriptRepository` (implemented in
`@infra/repositories.http/transcriptRepository.http.ts`):

- `availableLanguages(trackId)` reads `track_variants` where
  `transcript_path IS NOT NULL`.
- `get(trackId, language)` reads `track_variants.transcript_path`, resolves
  the full URL via `IStoragePublicUrl.get(path)`, pipes through
  `IRemoteFilesStorage.get(url)` (which caches the file locally), and
  `fetch`es the local URL and `JSON.parse`s the body.

Subsequent opens of the same transcript come from the cache — the
first-load network cost is paid once per transcript per device.

## 9. Resource map

| Resource      | CDN path                                         | Local path                                    |
|---------------|--------------------------------------------------|-----------------------------------------------|
| Remote config | `/public/config.json`                            | — (cached by `filesStorage`)                  |
| Content DB    | `/public/db/shruti.{version}.db`              | `shruti/databases/shruti.{version}.db`  |
| User DB       | —                                                | `user.db` (native) / `shruti/databases/user.db` (web) |
| Track audio   | `/public/tracks/{trackId}/audio/original.mp3`    | cached by `filesStorage` / `IMediaDownloader` |
| Transcript    | `/public/tracks/{trackId}/transcripts/{lang}.json` | cached by `filesStorage`                     |

Full URL is formed by the active CDN server's template; see Section 3.

## 10. Publishing a new DB scheme

1. Add a new SQL migration under `modules/tools/content-db-builder/migrations/`
   (e.g. `002_add_foo.sql`). First line must be `-- scheme: <YYYYMMDD>`.
2. Run `npm run build` in `modules/tools/content-db-builder/` to rebuild
   the content DB with both migrations applied.
3. Run `npm run upload` to push the DB and any changed transcripts to
   every CDN bucket as `/public/db/shruti.{new_version}.db`, and update
   `/public/config.json` to include the new `{ version, scheme }` entry.
   Keep old entries for clients still on the previous scheme.
4. Add `docs/db/scheme.{new_scheme}.md` alongside the old one.
5. Bump the `scheme` value in `modules/db-scheme.json` (single source of
   truth). Run `bash modules/db-sync.sh` to refresh bundled DBs for
   android/ios/e2e.
