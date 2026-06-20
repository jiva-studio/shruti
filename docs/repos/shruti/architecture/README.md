# Architecture

Shruti is a TypeScript monorepo organized around **hexagonal / clean architecture**: a pure domain core, use cases above it, and platform adapters behind ports. The outermost layer (`shruti/`) wires everything together.

Top-level layout:

- `modules/apps/mobile/` — the user-facing mobile app (Vue 3 + Ionic + Capacitor) and the composition root. Internally split into `ui/` (Vue components/features), `usecases/` (`@usecases` — application use cases that orchestrate domain services + repository ports), `shruti/` (composition root: stores, router, views, services, i18n), `ports/app/` (`@ports` — driven-port interfaces) and `infra/` (`@infra` — adapter implementations behind those ports). The shared `@lib/*` packages are pulled in via `submodules/` symlinks.
- `modules/libs/domain/` (`@shruti/domain`, aliased `@lib/domain`) — pure entities, value objects, domain services (`modules/libs/domain/services`) and repository ports (`modules/libs/domain/ports`).
- `modules/libs/contracts/` (`@lib/contracts`) — zero-dependency shared-kernel of wire/transport contracts (most notably the chat SSE protocol, snake-case wire shapes) imported by both a use case and an infra adapter.
- `modules/libs/persistence/main` (`@shruti/persistence-main`) and `modules/libs/persistence/user` (`@shruti/persistence-user`) — TypeScript row types for the published content DB and the on-device user DB.
- `modules/plugins/audio-player/` (`@shruti/plugin-audio-player`) and `modules/plugins/media-downloader/` (`@shruti/plugin-media-downloader`) — native Capacitor plugins for background audio playback and resumable downloads.
- `modules/tools/shruti-mcp/` — the content pipeline (MCP server) that ingests, transcribes, reviews and publishes the catalog SQLite DB and content assets to S3. Sibling tools: `attribution-importer`, `transcriber-service`/`transcriber-mcp`, `denoiser-service`/`denoiser-mcp`, `sr-transliterate`, `subscription-badges`.
- `modules/services/` — the backend Go/FastAPI services (see below).

## Backend

The content plane is **CDN-direct**: public lectures, transcripts, and the catalog `config.json` are served straight from per-region object storage (AWS S3 `us-east-1` for `global`, Yandex Object Storage for `russia`). The mobile app probes the candidate hosts at startup and pins the first reachable one — the server list lives in `modules/libs/domain/servers.ts` (`CdnServer`). User data (notes, playlist, downloads, listening history) lives in a local SQLite `user.db` on the device.

Beyond static content, the app talks to a small set of **per-region HTTP backends**, all addressed through the active `CdnServer` so a region flip re-routes traffic without an app restart:

- **`chat`** (`modules/services/chat`, `chatBaseUrl`) — powers the Sadhu chat agent. Requests carry a small slice of user state (recent tracks, current playback, timezone) as stateless context. The proactive-messages subsystem (see [`proactive-messages.md`](./proactive-messages.md)) reuses this for the `weekly_digest`, `inactivity` and `holiday` rule kinds, sending aggregate listening stats and recent topic tags so the LLM can curate suggestions; the local-template rules (`enable_notifications_hint`, `smart_library_hint`, `next_shloka`) never touch the network.
- **`auth`** (`modules/services/auth`, `authBaseUrl`) — stateless Go API that issues/refreshes RS256 JWTs for Google / Apple / `device_id` identities. The app drives it through `infra/auth` behind the `auth.ts` port.
- **`share-audio`**, **`share-video`** and **`share-transcript`** (`modules/services/{share-audio,share-video,share-transcript}`, `shareAudioUrl` / `shareVideoUrl` / `shareTranscriptUrl`) — cut an MP3 excerpt, render a 9:16 reel, or render a transcript PDF from a fragment and republish it as a public asset. Driven via `infra/shareAudio`, `infra/shareVideo` and `infra/shareTranscript` (`share.ts` / `shareAudio.ts` / `shareVideo.ts` / `shareTranscript.ts` ports). `shareTranscriptUrl` is optional in `config.json` — the composition root derives it from `chatBaseUrl` when absent, since the share-* routes sit behind the same per-region Caddy as chat.

A backend-only **`cleanup-worker`** (`modules/services/cleanup-worker`) consumes cross-service domain events from a transactional outbox (e.g. purging a deleted user's Langfuse traces); the mobile client never calls it directly. No persistent server-side per-user profile is maintained beyond auth identities — chat requests are stateless aside from rate limiting.

## Documents

- [`chat-pipeline.md`](./chat-pipeline.md) — end-to-end chat agent flow: router → research (single-stage ANN fanout + curator attributions) → synthesis planner (per-thesis cosine grounding) → synthesizer, all on one cosine scale.
- [`layers.md`](./layers.md) — authoritative layering rules, allowed imports, and a decision tree for where new code goes.
- [`startup-flow.md`](./startup-flow.md) — bootstrap sequence from `main.ts` to the first database query, including CDN probing and offline fallback.
- [`proactive-messages.md`](./proactive-messages.md) — mobile-driven scheduler for agent-initiated chat messages (weekly digests, holidays, inactivity nudges, contextual upsells).
- [`attribution.md`](./attribution.md) — curated question/topic → verse mapping pipeline: YAML plan → MCP importer → `library.db` → S3 → chat-service Postgres mirror → vector lookup at chat time.

Related reference:

- [`../runbooks/storage.md`](../runbooks/storage.md) — S3 bucket layout, path conventions, CDN mirrors.
- [`../db/`](../db/) — versioned content-database scheme docs.
