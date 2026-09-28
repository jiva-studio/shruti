# @infra — Driven adapters

Each subdirectory implements one or more technical ports from `@ports/app` or domain ports from `@lib/domain/ports`. Adapters can import `@ports/app`, `@lib/domain`, `@lib/persistence/*`, and `@infra/idbKv` only; sibling `@infra/*` directories may not import each other.

Adapters by area:

- **Persistence and files**: `persistence/sqljs`, `persistence/capacitor`, `persistence/fetchers/idb`, `persistence/fetchers/fs`, `files/web`, `files/capacitor`, `storagePublicUrl`, `preferences/capacitor`, `servers`, `idbKv`.
- **Repositories**: `repositories/sql` (user DB repositories), `repositories.preferences`.
- **Remote content**: `repositories/http` (transcripts over HTTP from public S3).
- **Device**: `audio/capacitor`, `audio/web`, `notifications/capacitor`, `share/capacitor`, `haptics/capacitor`, `haptics/web`.
- **Downloads**: `mediaDownloader/capacitor`, `mediaDownloader/web`.
