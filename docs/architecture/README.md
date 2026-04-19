# Architecture

Shruti is a TypeScript monorepo organized around **hexagonal / clean architecture**: a pure domain core, use cases above it, and platform adapters behind ports. The outermost layer (`shruti/`) wires everything together.

Top-level layout:

- `modules/apps/mobile/` — the user-facing mobile app (Vue 3 + Ionic + Capacitor).
- `modules/libs/domain/` — pure entities, value objects, domain services, repository ports.
- `modules/libs/application/` — use cases that orchestrate domain logic and ports.
- `modules/libs/persistence/` — TypeScript row types for the SQL databases.
- `modules/libs/audioPlayer/` — native Capacitor plugin for audio playback.
- `modules/tools/content-db-builder/` — Node.js tool that builds the prebuilt SQLite file and uploads content (transcripts, audio manifests) to S3.
- `modules/tests/e2e/` — Playwright end-to-end tests.

## Backend

The mobile app has **no backend**. All content lives in a public S3 bucket (`public/`), served directly to the app via the CDN mirrors listed in `@lib/domain/servers`. User data (notes, playlist, downloads) is stored locally in a SQLite `user.db` on the device and never leaves it.

## Documents

- [`layers.md`](./layers.md) — authoritative layering rules, allowed imports, and a decision tree for where new code goes.
- [`startup-flow.md`](./startup-flow.md) — bootstrap sequence from `main.ts` to the first database query, including CDN probing and offline fallback.

Related reference:

- [`../storage.md`](../storage.md) — S3 bucket layout, path conventions, CDN mirrors.
- [`../db/`](../db/) — versioned content-database scheme docs.
