<!-- BEGIN AUTOGEN -->
# shruti

<p align="center">
    <img src="assets/logo.png" height="184px"/>
</p>

<p align="center"><i>
Shruti is your personal lecture companion — listen to lectures, follow along with synced transcripts, save what matters, and ask an AI assistant about anything you hear. Whether you're commuting, walking, or relaxing at home, Shruti makes learning accessible on the go.
</i></p>

<p align="center">
  <img src="assets/splash.png"/>
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/listen-to-sadhu/id6745510353">
    <img src="assets/download-app-store.png" height="50" alt="Download on the App Store">
  </a>
  <a href="https://play.google.com/store/apps/details?id=studio.jiva.shruti">
    <img src="assets/download-google-play.png" height="50" alt="Get it on Google Play">
  </a>
</p>

# Features

🎓 **A library of lectures in one place**
Browse a curated catalog by author, location, source, tag, or language — all searchable full-text from your phone.

🎧 **Take your learning offline**
Download lectures for offline playback. No Wi-Fi, no problem.

📖 **Read while you listen**
Auto-synced transcripts highlight the current sentence as the lecture plays. Tap to jump, select to copy or share.

🔖 **Save what matters**
Bookmark any moment with a highlight on the transcript. Your notes are searchable and shareable, and tapping one jumps you back to the exact second.

💬 **Ask the assistant**
A built-in AI chat answers questions grounded in the lecture corpus and cites the exact passages — verses, purports, and timestamps — it drew from.

🔗 **Share a moment**
Turn any selection into a shareable audio clip, video, or transcript snippet to send to a friend.

🔥 **Build a listening habit**
A queue keeps your "up next" ready, and an activity heatmap and streak counter show your consistency at a glance.

# Architecture

The **mobile app** (Ionic + Capacitor + Vue 3) ships a prebuilt SQLite catalog inside the APK/IPA and pulls fresher versions from the CDN in the background. Lecture audio and transcripts are public files served over HTTPS from S3, so core browsing, playback, and reading work fully offline with no server round-trips.

A small **backend** powers the online features: a Go `auth` service (JWT over Google/Apple/device identities), a Python `chat` service (semantic, cited AI answers over the transcript corpus), and `share-audio` / `share-transcript` / `share-video` for generating shareable clips. These run behind a shared `infra/` stack (Postgres + Caddy). Content is produced and published by the `shruti-mcp` toolchain, which owns the catalog SQLite and the transcription/denoising pipelines.

The codebase follows **hexagonal / clean / DDD** architecture. Internal documentation (architecture layers, startup flow, storage layout, DB schemas) lives in `docs/` and is served as a docsify site.

# Repository layout

```
modules/
├── apps/
│   └── mobile/                 # Ionic + Capacitor + Vue 3 mobile app
│       ├── usecases/           # Application layer — use cases (depend on @lib/domain only)
│       ├── ui/                 # Views, features, components, primitives
│       └── ports/              # Technical (server-facing) port shapes
├── libs/
│   ├── domain/                 # Entities, value objects, domain ports (zero deps)
│   ├── contracts/              # Shared API/data contracts
│   └── persistence/            # DB row type schemas (main + user)
├── plugins/
│   ├── audio-player/           # In-house Capacitor plugin (native Android/iOS/web)
│   └── media-downloader/       # Background download Capacitor plugin
├── kit/                        # Shared mobile build/test tooling
├── services/
│   ├── auth/                   # Go — JWT auth over Google/Apple/device identities
│   ├── chat/                   # Python — cited AI chat over the transcript corpus
│   ├── share-audio/            # Go — shareable audio clips
│   ├── share-transcript/       # shareable transcript snippets
│   ├── share-video/            # Go — shareable video clips
│   ├── search-mcp/             # Go — read-only semantic search MCP
│   └── cleanup-worker/         # Go — background maintenance
└── tools/
    └── shruti-mcp/          # Go MCP service that owns the catalog SQLite and publishes it to S3
                                # (+ transcriber / denoiser services and MCPs)
```

# Project links

| Service | Purpose |
| --- | --- |
| [Qase](https://app.qase.io/project/SHRUTI) | Test management & release runs |
| [Sentry](https://akdasa-studio.sentry.io/issues/?project=4511584811220992) | Error & crash tracking |
| [Langfuse](https://langfuse.obs.eu.shruti.jiva.studio/) | LLM/chat observability & prompt management |
| [Grafana](https://grafana.obs.eu.shruti.jiva.studio/) | Metrics & infrastructure dashboards |

# Get involved

1. First-time setup: `make mobile-install` (installs npm deps for the mobile app).
2. `make help` from the repo root lists every entry point — dev server, Android/iOS builds, Fastlane screenshots, transcriber/MCP daemons, worktrees.
3. Common starting points: `make mobile` (dev server on :11001), `make mobile-build` (debug APK — runs `npm ci` itself, no setup needed), `make mobile-deploy` (install on connected device).
<!-- END AUTOGEN -->

<!-- USER NOTES -->
<!-- Anything below is preserved across regeneration. -->

## Documentation

- **Architecture**
  - [Overview](architecture/) — entry point: hexagonal/clean, top-level layout, no backend.
  - [Layer rules](architecture/layers.md) — authoritative dependency rules, allowed imports, decision tree.
  - [Startup flow](architecture/startup-flow.md) — `main.ts` → first DB query, CDN probing, offline fallback, retry loop.
  - Chat — [pipeline](architecture/chat-pipeline.md), [intents & routing](architecture/chat-intents.md), [mobile ↔ server protocol](architecture/chat-protocol.md).
  - [Multi-language chat & UI](architecture/multilanguage.md) — content vs UI language, fallback rules.
  - [Attribution lookup](architecture/attribution.md) — pinned shlokas / boosts, the `locate` intent.
  - [Proactive messages](architecture/proactive-messages.md) — rule engine, arbitration, one winner per day.
  - [Authentication](architecture/auth.md) — JWT refresh rotation, RevenueCat reconcile.
  - [Subscriptions & RevenueCat](architecture/subscriptions.md) — tiers, webhook→reconcile→token, paywall, chat quota.
  - [Background playlist (Pro)](architecture/background-playlist.md) — native-owned queue, durable journal, resume reconcile.
  - [Observability (Langfuse)](architecture/observability.md) — trace ids, prompt management.
  - [Profile sync](architecture/profile-sync.md) — design of the `profile` sync service: change-log + HLC, per-type merge, own Postgres, chat synced by default.
  - **Flows** — sequence diagrams: [play track](architecture/flows/playback.md), [transcript load](architecture/flows/transcript-load.md), [DB refresh](architecture/flows/content-db-refresh.md), [note create](architecture/flows/note-create.md), [media download](architecture/flows/media-download.md).
- **Domain**
  - [Overview](domain/) — pure layer, ports, error policy.
  - [Entities](domain/entities.md) — Track, TrackVariant, Note, PlaylistItem, MediaItem with class diagrams + state machines.
  - [Value objects](domain/value-objects.md) — id aliases, `Result<T,E>`, scalars.
  - [Ports](domain/ports.md) — 16 repository / unit-of-work interfaces with implementations map.
- **Database**
  - [Overview](db/) — two-DB architecture, engines per platform.
  - [ER diagram](db/er-diagram.md) — Mermaid diagram of the content DB.
  - [Content DB tables](db/content-db.md) — table-by-table walkthrough.
  - [User DB](db/user-db.md) — migrations, tables, lifecycle.
  - [ID generation](db/ids.md) — prefixed nanoid scheme, stable mapping for catalog ids.
  - [Scheme 20260420 (raw SQL)](db/scheme.20260420.md) — versioned snapshot.
- **Infrastructure**
  - [Overview](infra/) — bucket + CDN big picture.
  - [S3 layout](infra/s3-layout.md) — keys, content types, producer pipeline.
  - [CDN](infra/cdn.md) — mirror list, probe algorithm with timeouts, version selection, caching.
- **API**
  - [Use cases](api/use-cases.md) — 31 application use cases across 8 feature groups, with signatures and error tags.
- **UI**
  - [Components](components/) — view / feature / component / primitive layer stack, controller pattern, mirror types.
- **Modules & services**
  - [Audio player plugin](modules/audio-player.md) — Capacitor plugin (Android/iOS/web).
  - [media-downloader](modules/media-downloader.md) — offline-download orchestration.
  - [share-audio](modules/share-audio.md) — stream-copy MP3 excerpt cutter (Go, in-process dispatcher).
  - [share-video](modules/share-video.md) — 9:16 reel renderer (Go, Postgres queue + ffmpeg, JWT + quotas).
  - [share-transcript](modules/share-transcript.md) — on-demand transcript-PDF renderer (extracted out of chat).
  - [search-mcp](modules/search-mcp.md) — read-only pgvector MCP for curating library attributions.
  - [cleanup-worker](modules/cleanup-worker.md) — app.outbox consumer (Langfuse purge, retention crons).
- **Runbooks**
  - [Development environment](runbooks/development-environment.md) — local mobile-app workflow (no backend stack).
  - [Testing & Qase](runbooks/testing.md) — unit/e2e layout, Qase release runs.
  - [shruti-mcp](runbooks/shruti-mcp.md) — catalog MCP daemon, pipeline stages, publishing.
  - [track-selector](runbooks/track-selector.md) — selector syntax for pipeline fan-out.
  - [RevenueCat webhook secret rotation](../../runbooks/rc-webhook-secret-rotation.md) — dual-slot Bearer rotation.
  - [App Store certificates](runbooks/certificates.md) — signing setup, `APPLE_CERTIFICATES` secret, Fastlane.
  - [Storage layout (legacy)](runbooks/storage.md) — preserved; superseded by Infrastructure section above.

---

> _Docs last reconciled to source at commit **`63323203`** on **2026-06-20**. Machine state in `docs/.docs-sync.json`; maintained by the `docs-generate` skill — the next update only has to diff `63323203..HEAD`._
