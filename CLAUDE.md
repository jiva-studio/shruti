# Claude Code — project conventions

Shruti is a mobile-only app that serves lectures (audio + transcripts) from a public S3 bucket. No backend, no authentication, no telemetry — just the Ionic/Vue app and static files on S3.

## Architecture

The codebase follows **hexagonal / clean / DDD architecture**. Before making architectural decisions, read:

- `docs/architecture/README.md`
- `docs/architecture/layers.md`
- `docs/architecture/startup-flow.md`
- `docs/storage.md`

The mobile app lives in `modules/apps/mobile/`. Shared libraries live in `modules/libs/`. The content-db-builder tool lives in `modules/tools/`. Nothing else.

## Conventions

- **ES module imports.** All imports use explicit `.js` extensions even in `.ts` source files: `import { foo } from "./bar.js"`.
- **Controller pattern.** Non-trivial Vue views split business logic into a sibling `*.controller.ts` file that returns `{ data, isLoading, error, handlers }`.
- **`Result<T, E>`.** Application use cases return `Result<T, E>` for recoverable failures. Exceptions are reserved for programmer errors (bugs).
- **UI mirror types.** `@ui/features/*` never imports from `@lib/domain`. When a UI feature needs a type from the domain, it declares a structurally identical mirror type locally.
- **Single source of truth for paths.** SQLite stores **full paths from the bucket root** (including the `public/` prefix). `IStoragePublicUrl.get(path)` only substitutes `{path}` in the active server template.
- **Content DB is read-only.** The mobile runtime never writes to the prebuilt DB. Scheme version is read from the last row of the `migrations` table.

## Agents

Two Claude Code agents are configured in `.claude/agents/`:

- `architector` — for designing where new code goes, proposing types and ports. Outputs plans, not implementations.
- `ionic-mobile-developer` — for writing Ionic/Vue/Capacitor feature code following the layer rules.

Use the architector before the developer on any non-trivial feature.
