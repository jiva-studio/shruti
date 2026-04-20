# @infra — Driven adapters

Each subdirectory implements one or more technical ports from `@ports/app` or domain ports from `@lib/domain/ports`. Adapters can import `@ports/app`, `@lib/domain`, `@lib/persistence/*`, and `@infra/idb.kv` only; sibling `@infra/*` directories may not import each other.

Populated per phase:

- **Phase 3**: `persistence.sqljs`, `persistence.capacitor`, `persistence.fetchers.idb`, `persistence.fetchers.fs`, `files.web`, `files.capacitor`, `storage.public.url`, `preferences.capacitor`, `servers`, `idb.kv`.
- **Phase 4**: `repositories.sql` (user DB repositories), `repositories.preferences`.
- **Phase 5**: `repositories.http` (transcripts over HTTP from public S3).
- **Phase 6**: `audio.capacitor`, `audio.web`, `notifications.capacitor`, `share.capacitor`, `haptics.capacitor`, `haptics.web`.
- **Phase 7**: `mediaDownloader.capacitor`, `mediaDownloader.web`.
