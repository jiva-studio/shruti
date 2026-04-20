# Architecture: Layer Structure

This document describes the layered architecture of the Lectorium mobile app,
the dependency rules that govern it, and how to decide where new code should
live.

The architecture follows **hexagonal / clean architecture** principles:
dependencies flow inward (toward the domain), the domain knows nothing about
the outside world, and platform-specific concerns live behind ports.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      COMPOSITION ROOT                               │
│  lectorium/lectorium.ts · views/ · router/ · main.ts                │
│  Wires ports → adapters → use cases → views. Only place that        │
│  knows every concrete adapter.                                      │
└───────┬──────────┬──────────┬──────────┬──────────┬─────────────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐
   │ @ports/ │ │ @infra/│ │  @ui/  │ │ @lib/  │ │    @lib/     │
   │   app   │ │  (all) │ │ (all)  │ │  app-  │ │   domain     │
   │         │ │        │ │        │ │ lication│ │              │
   └─────────┘ └────────┘ └────────┘ └────────┘ └──────────────┘
```

### Hexagonal View

```
                   ┌──────────────────────────────┐
                   │      APPLICATION CORE         │
                   │                                │
    Driving        │  @lib/domain     entities,     │        Driven
    Adapters       │                  services,     │       Adapters
   ┌─────────┐     │                  domain ports  │     ┌──────────┐
   │lectorium│────▶│                                │◀────│ @infra/  │
   │ views   │     │  @lib/application              │     │repos.sql │
   │         │     │                  use cases     │     │repos.http│
   └─────────┘     │                                │     │persist.* │
                   └──────────────────────────────┘     └──────────┘
                          ▲              ▲
                     @ports/app     @lib/domain/ports
                   (tech ports)     (domain ports)
```

## Layer Reference

### `@lib/domain` — Domain Core (innermost)

| | |
|---|---|
| **Path** | `modules/libs/domain/` |
| **Role** | Entities, value objects, domain services, domain repository ports |
| **May import** | Nothing — zero external dependencies |
| **Must NOT import** | `@lib/application`, `@ports`, `@infra`, `@ui`, `vue`, any platform API |
| **Contains** | `Track`, `TrackVariant`, `Author`, `Location`, `Source`, `Language`, `Tag`, `Reference`, `Transcript`, `TranscriptBlock`, `Note`, `PlaylistItem`, `MediaItem`, `Result`, `RemoteAppConfig`, `CdnServer`, `SERVERS`, UI constants `durationFilters`, `sortMethods` |
| **Ports subdir** | `ports/` — `ITrackRepository`, `IAuthorRepository`, `ISourceRepository`, `ILocationRepository`, `ILanguageRepository`, `ITagRepository`, `ITranscriptRepository`, `INoteRepository`, `IPlaylistItemRepository`, `IMediaItemRepository`, `IUnitOfWork` |

### `@lib/application` — Use Cases

| | |
|---|---|
| **Path** | `modules/libs/application/` |
| **Role** | Orchestrate domain logic + repository ports. Pure functions, no Vue, no IO. |
| **May import** | `@lib/domain` only |
| **Must NOT import** | `@ports`, `@infra`, `@ui`, `vue`, platform APIs |
| **Contains** | `addTrackToPlaylist`, `createNote`, `listPlaylistTracks`, `listTracksByFilters`, `loadTranscript`, `searchNotes`, `searchTracks` |

### `@ports/app` — Technical Contracts (Layer 0)

| | |
|---|---|
| **Path** | `modules/apps/mobile/ports/app/` |
| **Role** | Interfaces for technical infrastructure: database, persistence, file storage, URL resolution, audio, platform SDKs |
| **May import** | Nothing — zero external dependencies |
| **Must NOT import** | `@lib/domain`, `@infra`, `@ui`, anything |
| **Contains** | `IDatabase`, `IPersistence`, `IDatabaseFetcher`, `IRemoteFilesStorage`, `IStoragePublicUrl`, `IPreferences`, `ISchemeVersionRepository`, `IDatabaseTransfer`, `IAudioPlayer`, `IMediaDownloader`, `INotificationScheduler`, `IShareService` |

### `@infra/*` — Driven Adapters (Layer 2)

| | |
|---|---|
| **Path** | `modules/apps/mobile/infra/` |
| **Role** | Implement ports. Own all SQL, row types, platform SDK calls. |
| **May import** | `@ports/app`, `@lib/domain` (types + domain services), `@lib/persistence/*` (row types), `@infra/idb.kv` (Layer 1 primitive only) |
| **Must NOT import** | `@ui`, `@lectorium`, `@lib/application`, other `@infra/*` siblings (except `idb.kv`) |
| **Subdirectories** | |
| `infra/idb.kv/` | Layer 1 primitive — low-level IDB KV store, zero deps |
| `infra/repositories.sql/` | Implements domain repository ports via `IDatabase` + SQL. Owns all `rowTo*` mappers. Only place that imports `@lib/persistence/*` row types. |
| `infra/repositories.http/` | HTTP-backed repositories (transcripts fetched as JSON from S3) |
| `infra/persistence.sqljs/` | `IPersistence` for web (sql.js + IDB) |
| `infra/persistence.capacitor/` | `IPersistence` for native (Capacitor SQLite) |
| `infra/persistence.fetchers.idb/` | `IDatabaseFetcher` for web (HTTP → IDB) |
| `infra/persistence.fetchers.fs/` | `IDatabaseFetcher` for native (FileTransfer → FS) |
| `infra/files.web/` | `IRemoteFilesStorage` for web (Cache API) |
| `infra/files.capacitor/` | `IRemoteFilesStorage` for native (Filesystem) |
| `infra/storage.public.url/` | `IStoragePublicUrl` (URL template resolver) |
| `infra/preferences.capacitor/` | `IPreferences` for native (`@capacitor/preferences`) |
| `infra/audio.capacitor/` | `IAudioPlayer` wrapping `@lectorium/audio-player` plugin |
| `infra/audio.web/` | `IAudioPlayer` over `HTMLAudioElement` |
| `infra/notifications.capacitor/` | `INotificationScheduler` (local notifications) |
| `infra/servers/` | CDN server probing (`probeServers`) |

### `@ui/*` — UI Layer (Layer 3)

| | |
|---|---|
| **Path** | `modules/apps/mobile/ui/` |
| **Role** | Reusable, self-contained UI components. Props + events, no infra deps. |
| **May import** | `vue`, `@ionic/vue`, lower UI sub-layers (see below), own files only |
| **Must NOT import** | `@ports`, `@infra`, `@lib/domain`, `@lib/application`, `@lectorium/*`, cross-feature UI siblings |

The UI layer has four **stacked sub-layers**. Dependencies flow
downward only. Siblings at the `features/` level may NOT import each
other — shared widgets must be promoted to `@ui/components/`.

```
  features/       can import: components, primitives, icons
     ▼
  components/     can import: components (siblings), primitives, icons
     ▼
  primitives/     can import: nothing UI — zero deps
  icons/          can import: nothing UI — zero deps (parallel to primitives)
```

| Sub-layer | Contents |
|---|---|
| `ui/primitives/` | No-dep building blocks: `AppPage`, `Header`, `HighlightText`, `HoldButton`, `Message`, `PageSticker`, `SectionHeader`, `WithDeleteAction` |
| `ui/icons/` | SVG icons (`IconHome`, `IconBookmark`, …). Parallel to primitives — no UI deps |
| `ui/components/selectors/` | Generic selector dialogs (`SelectorDialog`, `ListItemSelectorDialog`, `ListItemsSelectorDialog`) |
| `ui/components/tracks.list/` | Track list item + list container (takes `UiTrackRow` mirror type) |
| `ui/components/tracks.search.input/` | Cross-platform search input (`SearchInput`) |
| `ui/components/tracks.state/` | Track state indicators (`IconIndicator`, `RadialIndicator`) |
| `ui/features/notes/` | Note list item + editor |
| `ui/features/player/` | Audio player controls, waveform, seek |
| `ui/features/playlist/` | Playlist items, swipes, progress bars |
| `ui/features/settings/` | Settings items: app language, server, notifications, toggles |
| `ui/features/tracks.search.filters/` | Filter chips (authors, sources, languages, duration, tags) |
| `ui/features/transcript/` | Transcript viewer (paragraph/sentence/verse blocks) |

### UI Mirror Types

`@ui/*` can't import from `@lib/domain` (UI must not know the domain).
When a component needs a type that already exists there, it declares a
**mirror** — a structurally identical copy kept alongside the
component's other types, typically in a local `types.ts`.

**When to mirror.** Only for the specific shape the UI actually renders.
Don't re-export the whole domain entity — lift out the three or four
fields the component needs and alias the rest away at the boundary.

**Sync rule.** A mirror is a snapshot, not a live link. When the source
type gains a field or tightens a union, the mirror (and the builder that
produces its values) must be updated in the same change. TypeScript
won't catch the drift — structural compatibility silently absorbs it.

A single composable per surface (e.g. `buildTranscriptViewData` in
`lectorium/composables/`) is the **one place** that converts domain
inputs into these UI types. Adding a new surface field means: update the
domain type, update its mirror, update the builder, update the template
— in that order.

### `lectorium/` — Composition Root + Driving Adapters

| | |
|---|---|
| **Path** | `modules/apps/mobile/lectorium/` |
| **Role** | Wire everything together (lectorium.ts), define routes, host Vue views |
| **May import** | Everything — this is the outermost layer |
| **Contains** | `lectorium.ts` (singleton, lazy `repositories()`), `router/`, `main.ts`, `App.vue`, `views/` (Welcome, Home, Search, Track, Notes, Settings) |
| **Views** | Thin reactive shims that call use cases from `@lib/application` and bind results to `@ui/*` components via controllers |

### `@lib/persistence/*` — DB Row Schemas

| | |
|---|---|
| **Path** | `modules/libs/persistence/main/`, `modules/libs/persistence/user/` |
| **Role** | TypeScript types for raw SQL row shapes. Infra concern, not domain. |
| **May import** | Nothing |
| **Used by** | Only `@infra/repositories.sql/` |

## Dependency Rule

**Imports flow inward/downward only. Siblings at the same layer never
import each other.**

```
lectorium/  →  @ui, @infra, @ports, @lib/application, @lib/domain
@ui/*       →  (nothing external)
@infra/*    →  @ports, @lib/domain, @lib/persistence, @infra/idb.kv
@lib/application  →  @lib/domain
@lib/domain       →  (nothing)
@ports/app        →  (nothing)
```

### How to Verify

```bash
# No cross-feature imports inside @ui/features (promote shared widgets
# to @ui/components/):
grep -rn 'from "@ui/features/' ui/features/

# No @infra inside @ui or @ports:
grep -rn 'from "@infra/' ui/ ports/

# Domain is pure:
grep -rn 'from "@' modules/libs/domain/ | grep -v '@lib/domain'

# Application depends only on domain:
grep -rn 'from "@' modules/libs/application/ | grep -v '@lib/domain'

# Row types only in repositories.sql:
grep -rn '@lib/persistence/' infra/ | grep -v 'repositories.sql'
```

ESLint's `no-restricted-imports` enforces the same rules at lint time — see
`eslint.config.js` in the mobile app. Each UI sub-layer has its own rule
block that encodes the allowed downward imports.

## Error-Handling Policy

Errors are handled differently depending on which layer raised them. The rule
of thumb: **views never see raw exceptions from use cases**.

| Layer | Strategy | Rationale |
|---|---|---|
| `@lib/domain` | Pure functions. Throw only on programmer error / impossible states. Use `Result<T, E>` for domain-level validation failures. | The domain is deterministic; a thrown error here is always a bug. |
| `@lib/application` | Return `Result<T, E>` for recoverable failures (not found, stale state, conflict). Let `@infra` exceptions propagate only if the use case has no meaningful fallback — the composition-root wrapper will catch them. | Views must be able to discriminate `ok` vs `error` branches without try/catch. |
| `@infra/*` | Throw on data-invariant violations. May throw on platform failures (DB locked, file missing) — these are caught and mapped to `Result.error` inside application use cases or the view controller. | Invariant violations are bugs, not recoverable errors, and should surface loudly during development. |
| `@ui/*` | Never catches **use-case or resolver errors** — those must propagate to the view controller. Narrow carve-out: browser-platform lifecycle quirks (e.g. `HTMLAudioElement.play()` rejecting when autoplay is blocked). | UI is a pure renderer for application state; only per-component browser quirks belong inside it. |
| `lectorium/` (views + controllers) | Catch exceptions from use cases at the outermost edge and map them to view state (e.g. `screen: "error"`). | Last line of defense before the user sees a blank screen. |

**In practice:**

- A domain entity throws `"impossible state"` → it is a bug; fix the caller.
- A use case calls a repository that throws `"row inconsistent"` → the view
  controller catches it, logs it, shows an error screen. No retry.
- A use case tries to load a non-existent track → returns
  `{ ok: false, error: "not-found" }` — the view branches on the error tag.

`Result<T, E>` is defined in `modules/libs/domain/result.ts`. Prefer string
literal unions for the `E` type so TypeScript can narrow on the tag.

### `Result<T, E>` vs thrown — which use cases use which?

| Category | Pattern | Examples |
|---|---|---|
| **Mutation** use cases (create / update / delete / archive / mark) | Return `Result<T, E>` with a string-literal error union — callers branch on recoverable domain errors like `not-found`, `already-archived`, `invalid-range`. | `addTrackToPlaylist`, `archivePlaylistItem`, `createNote`, `updateNote`, `deleteNote`, `markCompleted`, `updateProgress` |
| **Query** use cases (list / search / load) | Return the result directly (`readonly T[]` or the loaded entity). Throw on infra failure (DB unopen, SQL error) — the composition-root wrapper catches it. `Result` is used only when there is a meaningful domain-level branch the UI needs to render differently. | `searchTracks`, `listTracksByFilters`, `searchNotes`, `listActivePlaylistTracks` return raw; `loadTranscript` returns `Result` because `no-transcript-available` vs `fetch-failed` need different UI treatments. |

The practical rule: **if the caller can do something different for each error
tag, use `Result`**. If every failure is just "something went wrong", throw and
let the controller render a generic error.

## Decision Tree: Where Does New Code Go?

```
Is it a pure business rule, entity, or value object?
  └─ YES → @lib/domain/

Is it a workflow that orchestrates domain logic + repository ports?
  └─ YES → @lib/application/

Is it a contract/interface for talking to infrastructure?
  └─ YES → @ports/app/

Does it implement a port (SQL, filesystem, HTTP, platform SDK)?
  └─ YES → @infra/<adapter-name>/

Is it a reusable UI component with props+events, no business logic?
  └─ YES → @ui/primitives/ (atomic, no-dep)
          or @ui/components/<area>/ (generic widget — used by multiple features)
          or @ui/features/<area>/ (specific to one feature surface)

Is it a Vue composable that wires stores / use cases / services?
  └─ YES → lectorium/composables/

Is it a Vue view, a route, or app-level wiring?
  └─ YES → lectorium/
```

## Composition Root Pattern

`lectorium/lectorium.ts` is the only file that knows every concrete adapter.
It exposes a `repositories()` method that lazily builds the SQL repository
bundle on first call (after databases are opened by the Welcome view):

```ts
const app = useLectorium()
const repos = app.repositories()
// { tracks, authors, sources, locations, languages, tags, transcripts,
//   notes, playlistItems, mediaItems, unitOfWork }
```

View controllers call `app.repositories()` and interact with the domain
through repository ports — never through `IDatabase` or raw SQL directly.
