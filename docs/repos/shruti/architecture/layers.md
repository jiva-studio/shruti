# Architecture: Layer Structure

This document describes the layered architecture of the Shruti mobile app,
the dependency rules that govern it, and how to decide where new code should
live.

The architecture follows **hexagonal / clean architecture** principles:
dependencies flow inward (toward the domain), the domain knows nothing about
the outside world, and platform-specific concerns live behind ports.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      COMPOSITION ROOT                               │
│  shruti/shruti.ts · views/ · router/ · main.ts                │
│  Wires ports → adapters → use cases → views. Only place that        │
│  knows every concrete adapter.                                      │
└───────┬──────────┬──────────┬──────────┬──────────┬─────────────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐
   │ @ports/ │ │ @infra/│ │  @ui/  │ │@usecases│ │    @lib/     │
   │   app   │ │  (all) │ │ (all)  │ │  (app   │ │   domain     │
   │         │ │        │ │        │ │ layer)  │ │              │
   └─────────┘ └────────┘ └────────┘ └────────┘ └──────────────┘
```

> **`@kit/*` is a separate toolkit.** A large body of
> reusable, cross-app code (the `@kit/core` / `@kit/servers` primitives,
> plus `@kit/ui` UI primitives, `@kit/infra` platform adapters, and
> `@kit/persistence` helpers) lives in `modules/kit/`. From the mobile app's point of view every `@kit/*`
> import obeys the same inward dependency rule as the shared kernel — see
> the Shared Kernel section below.

### Hexagonal View

```
                   ┌──────────────────────────────┐
                   │      APPLICATION CORE         │
                   │                                │
    Driving        │  @lib/domain     entities,     │        Driven
    Adapters       │                  services,     │       Adapters
   ┌─────────┐     │                  domain ports  │     ┌──────────┐
   │shruti│────▶│                                │◀────│ @infra/  │
   │ views   │     │  @usecases                     │     │repos.sql │
   │         │     │                  use cases     │     │repos.http│
   └─────────┘     │                                │     │persist.* │
                   └──────────────────────────────┘     └──────────┘
                          ▲              ▲
                     @ports/app     @lib/domain/ports
                   (tech ports)     (domain ports)
```

## Layer Reference

### Shared Kernel — `@kit/*` + `@lib/contracts` (foundation)

| | |
|---|---|
| **Path** | `modules/kit/` (the `@kit/*` toolkit) and `modules/libs/contracts/` (`@lib/contracts`) |
| **Role** | Cross-app **shared kernel / published language** (DDD) plus reusable platform plumbing. `@lib/contracts` owns the chat SSE **wire protocol** (`IChatStreamClient`, `IChatTitleService`, `IChatQuestionsService`, `IChatFeedbackService`, `IProactiveChatService`, `IChatResumeService` and their wire payload/event types). The `@kit/*` toolkit is itself layered (see sub-packages below): its `core`/`servers` tiers are dependency-free primitives, while `ui`/`infra`/`persistence` are reusable adapters lifted out of the app. |
| **May import** | `@lib/contracts` and `@kit/core`/`@kit/servers`: nothing external. `@kit/ui` may import `vue`/`@ionic`; `@kit/infra` may import platform SDKs + `@ports/app` it implements — each kit tier obeys the same inward rule internally. |
| **Imported by** | `@lib/domain`, `@usecases`, `@ports/app`, `@infra/*`, `@ui/*`, composition root |

**`@kit/*` sub-packages** (what each tier provides to the mobile app):

| Sub-package | Role | Provides |
|---|---|---|
| `@kit/core` | Dependency-free primitives | `Result`/`ok`/`err`, date math |
| `@kit/servers` | Dependency-free primitives | `CdnServer`, `SERVERS`, `buildServerUrl` |
| `@kit/ui` | Reusable UI primitives | `AppPage`, `BuildInfo`, `Header`, `IconChip`, `LazyImage`, `Message`, `PageSticker`, `ProBadge`, `SafeAreaHeaderGradient`, `SectionHeader` — re-exported from `ui/primitives/index.ts` |
| `@kit/infra` | Reusable driven adapters + their port types | `IRemoteFilesStorage`, `IStoragePublicUrl`, `IPreferences`, `IHaptics`, `INotificationScheduler`, `IShareService`, `IDatabaseTransfer` and their capacitor/web implementations + the `idbKv` KV primitive — re-exported from `ports/app/*` and wired in `main.ts` |
| `@kit/persistence` | Reusable persistence helpers | migration-runner used by `infra/persistence/migrations/` |

> **Why the chat wire types live in `@lib/contracts`.** The strict
> dependency rule (application → domain only; `@ports/app` → kernel only)
> leaves no shared home for a contract that both a use case and an adapter
> need — e.g. the chat stream port consumed by `runChatTurn` and
> implemented by `@infra/chat/http`. A dependency-free foundation layer is
> the idiomatic resolution: the port and its DTOs live there, and every
> layer may depend inward on it. It carries *transport* shapes (snake_case
> wire types), kept deliberately separate from the domain's own clean
> (camelCase) `ChatActionPayload` / `ChatOutlinePayload`.

### `@lib/domain` — Domain Core (innermost)

| | |
|---|---|
| **Path** | `modules/libs/domain/` |
| **Role** | Entities, value objects, domain services, domain repository ports |
| **May import** | The shared kernel only (`@kit/core` for `Result`, `@kit/servers` for `buildServerUrl`) — no framework, no platform, no ports/infra/ui |
| **Must NOT import** | `@usecases`, `@ports`, `@infra`, `@ui`, `vue`, any platform API |
| **Contains** | `Track`, `TrackVariant`, `TrackAudio`, `Author`, `Location`, `Source`, `Language`, `Tag`, `Topic`, `Reference`, `Transcript`, `TranscriptBlock` (discriminated union of `TranscriptParagraphBlock`, `TranscriptSentenceBlock`, `TranscriptVerseTextBlock`, `TranscriptVerseTranslationBlock`), `Note`, `PlaylistItem`, `MediaItem`, `ListeningSession`, `DailyListeningTotal`, `ChatSession`, `ChatMessage`, `Result`, `RemoteAppConfig` (with `ProactiveConfig`, `ProactiveRuleConfig`, `HolidayEntry`, `RemoteDbEntry`), `CdnServer`, `SERVERS`, `buildServerUrl`, branded id aliases (`TrackId`, `NoteId`, `ChatSessionId`, …), UI constants `durationFilters`, `dateFilters`, `sortMethods` |
| **Services subdir** | `services/` — pure domain services: `localizedName.ts` (`resolveLocalizedName`, `resolveLocalizedNameOrEmpty`, `resolveTrackTitle`, `preferredContentLanguage`, `preferredLibraryLanguage`), `references.ts` (`groupReferences`, `formatReference`, `formatReferenceFull`) |
| **Ports subdir** | `ports/` — `ITrackRepository`, `IAuthorRepository`, `ISourceRepository`, `ILocationRepository`, `ILanguageRepository`, `ITagRepository`, `ITopicRepository`, `ITranscriptRepository`, `INoteRepository`, `IPlaylistItemRepository`, `IMediaItemRepository`, `IListeningSessionRepository`, `IChatSessionRepository`, `IChatMessageRepository`, `IProactiveStateRepository`, `IUnitOfWork` |

> **Barrel note.** `Topic` and `ITopicRepository` are reached only via
> deep imports (`@lib/domain/topic.js`, `@lib/domain/ports/topicRepository.js`)
> — they are not yet re-exported from `domain/index.ts` / `ports/index.ts`.

### `@usecases` — Use Cases (application layer)

| | |
|---|---|
| **Path** | `modules/apps/mobile/usecases/` (aliased `@usecases`) — *this is the application layer; it was moved out of `modules/libs/application/` into the app and renamed.* |
| **Role** | Orchestrate domain logic + repository ports. Pure functions, no Vue, no IO. |
| **May import** | `@lib/domain` and the shared kernel (`@kit/*`, `@lib/contracts`) — e.g. `runChatTurn` consumes the chat stream port from `@lib/contracts` |
| **Must NOT import** | `@ports`, `@infra`, `@ui`, `@shruti`, `@lib/persistence`, `vue`, platform APIs |
| **Structure** | Eight feature subfolders, each exporting its use cases: |

| Subfolder | Use cases |
|---|---|
| `activity/` | `getActivityOverview`, `getDailyListeningHeatmap`, `buildHeatmapDays`, `computeCurrentStreak` |
| `chat/` | `buildChatUserContext`, `addTracksToPlaylist`, `saveCitationAsNote`, `runChatTurn`, `replayChatTurn`, `submitChatFeedback`, `recordInlineHintCooldown` |
| `discovery/` | `searchAndFilterTracks`, `buildRecommendations`, `listSimilarTracksByTopic` |
| `downloads/` | `downloadMedia`, `removeDownloadedMedia`, `downloadTranscripts`, `removeDownloadedTranscripts` |
| `library/` | `reduceLocaleToContentLanguage`, `defaultLibraryLanguages` |
| `notes/` | `createNote`, `updateNote`, `deleteNote`, `searchNotes`, `formatNoteShare` |
| `playback/` | `playTrack`, `loadTrackDetail`, `loadTranscript`, `getProgressForItem` |
| `playlist/` | `addTrackToPlaylist`, `archivePlaylistItem`, `listActivePlaylistTracks` |

### `@ports/app` — Technical Contracts (Layer 0)

| | |
|---|---|
| **Path** | `modules/apps/mobile/ports/app/` (all 19 port files live under `app/`; there are no top-level `ports/*.ts`) |
| **Role** | Interfaces for technical infrastructure: database, persistence, file storage, URL resolution, audio, platform SDKs |
| **May import** | The shared kernel only — several ports **re-export** their interface type from `@kit/infra` (see note). Otherwise zero dependencies. |
| **Must NOT import** | `@lib/domain`, `@usecases`, `@infra`, `@ui`, `@shruti` |
| **Defined locally** | `IDatabase`, `IPersistence`, `IDatabaseFetcher`, `ISchemeVersionRepository`, `IAudioPlayer`, `IMediaDownloader`, `IShareAudioService`, `IShareVideoService`, `IShareTranscriptService`, `IExcerptCache`, `IServerProber`, `IPurchases` (`PurchaseCancelledError`, `PurchaseNotAllowedError`), `AuthPort` |
| **Re-exported from `@kit/infra`** | `IRemoteFilesStorage`, `IStoragePublicUrl`, `IPreferences`, `IHaptics`, `INotificationScheduler`, `IShareService`, `IDatabaseTransfer` |

> **Chat contracts moved.** The chat service contracts
> (`IChatStreamClient`, `IChatTitleService`, `IChatQuestionsService`,
> `IChatFeedbackService`, `IProactiveChatService`, `IChatResumeService`)
> are **no longer in `@ports/app`** — they now live in `@lib/contracts`
> (shared kernel), because they carry the SSE wire protocol. `ports/app/index.ts`
> keeps only a comment pointing there.

### `@infra/*` — Driven Adapters (Layer 2)

| | |
|---|---|
| **Path** | `modules/apps/mobile/infra/` |
| **Role** | Implement ports. Own all SQL, row types, platform SDK calls. |
| **May import** | `@ports/app`, `@lib/domain` (types + domain services), `@lib/contracts`, `@lib/persistence/*` (row types), `@kit/*` (incl. `@kit/infra`/`@kit/persistence`), and the in-house `@shruti/plugin-*` packages |
| **Must NOT import** | `@ui`, `@shruti` (except `@shruti/plugin-*`), `@usecases`, other `@infra/*` siblings |
| **Subdirectories** | |
| `infra/repositories/sql/` | Implements domain repository ports via `IDatabase` + SQL. Owns all `rowTo*` mappers. Only place that imports `@lib/persistence/*` row types. |
| `infra/repositories/http/` | HTTP-backed repositories (transcripts fetched as JSON from S3) |
| `infra/persistence/sqljs/` | `IPersistence` for web (sql.js + IDB) |
| `infra/persistence/capacitor/` | `IPersistence` for native (Capacitor SQLite) |
| `infra/persistence/fetchers/idb/` | `IDatabaseFetcher` for web (HTTP → IDB) |
| `infra/persistence/fetchers/fs/` | `IDatabaseFetcher` for native (FileTransfer → FS) |
| `infra/persistence/migrations/user/` | User-DB schema migrations (run via `@kit/persistence`) |
| `infra/files/capacitor/` | `IRemoteFilesStorage` for native (Filesystem). *(The web variant moved to `@kit/infra`.)* |
| `infra/audio/capacitor/` | `IAudioPlayer` wrapping the in-house `@shruti/plugin-audio-player` plugin — single cross-platform adapter (native + web fallback handled inside the plugin); same single-adapter pattern as `mediaDownloader/plugin/` |
| `infra/mediaDownloader/plugin/` | `IMediaDownloader` over the in-house [`@shruti/plugin-media-downloader`](../modules/media-downloader.md) plugin (Android WorkManager + OkHttp, iOS background URLSession, Web Cache API) — single adapter for every platform |
| `infra/shareAudio/http/` | `IShareAudioService` — server-side audio-excerpt cutting over HTTP |
| `infra/shareVideo/http/` | `IShareVideoService` — server-side video-excerpt cutting over HTTP |
| `infra/shareTranscript/http/` | `IShareTranscriptService` — server-side transcript-share rendering over HTTP |
| `infra/excerptCache/capacitor/` | `IExcerptCache` — caches cut audio/video excerpts on the device |
| `infra/auth/capacitor/` | `AuthPort` — anonymous / account auth session management |
| `infra/purchases/capacitor/` | `IPurchases` (RevenueCat) — Pro subscription packages and customer state |
| `infra/chat/http/` | The chat service contracts (`IChatStreamClient`, `IChatTitleService`, `IChatQuestionsService`, `IChatFeedbackService`, `IProactiveChatService`, `IChatResumeService`) over SSE/HTTP |
| `infra/servers/` | `IServerProber` — CDN server probing (`probeServers`) |

> **Adapters relocated to `@kit/infra`.** A class of platform adapters
> that used to live under `infra/` now ships from the shared `@kit/infra`
> submodule and is wired in `shruti/main.ts`: `idbKv` (the low-level
> IDB KV primitive), `databaseTransfer` (capacitor + web), `files/web`,
> `haptics` (capacitor + web), `notifications/capacitor`,
> `preferences/capacitor`, `share/capacitor`, and `storagePublicUrl`.
> The old "`@infra/idbKv` is the one sibling-import carve-out" no longer
> applies — `idbKv` is now imported as `@kit/infra`, not a sibling.

### `@ui/*` — UI Layer (Layer 3)

| | |
|---|---|
| **Path** | `modules/apps/mobile/ui/` |
| **Role** | Reusable, self-contained UI components. Props + events, no infra deps. |
| **May import** | `vue`, `@ionic/vue`, lower UI sub-layers (see below), own files only |
| **Must NOT import** | `@ports`, `@infra`, `@lib/domain`, `@usecases`, `@shruti/*`, cross-feature UI siblings |

The UI layer has four **stacked sub-layers**. Dependencies flow
downward only. Siblings at the `features/` level may NOT import each
other — shared widgets must be promoted to `@ui/components/`.

```
  features/       can import: components, primitives, icons
     ▼
  components/     can import: components (any group), primitives, icons
     ▼
  primitives/     can import: nothing UI — zero deps
  icons/          can import: nothing UI — zero deps (parallel to primitives)
  shared/         can import: nothing UI — zero deps (parallel to primitives)
```

| Sub-layer | Contents |
|---|---|
| `ui/primitives/` | App-local no-dep building blocks: `CachedImage`, `FlatHeader`, `HighlightText`, `WithDeleteAction` (+ `useCachedImageUrl`, `filesStorageKey`). The classic primitives (`AppPage`, `BuildInfo`, `Header`, `IconChip`, `LazyImage`, `Message`, `PageSticker`, `ProBadge`, `SafeAreaHeaderGradient`, `SectionHeader`) now live in **`@kit/ui`** and are re-exported from `primitives/index.ts`. |
| `ui/icons/` | A single `index.ts` aliasing `@tabler/icons-vue` (`IconHome`, `IconSearch`, …). Parallel to primitives — no UI deps |
| `ui/shared/` | Cross-layer shared widgets that any UI sub-layer may use (`InlineNotice`). Parallel to primitives |
| `ui/components/` (top-level) | `LectureOutline`, `RowDivider`, `SectionLabel` (+ `types.ts` with `UiOutlineChapter` mirror) |
| `ui/components/badges/` | Generic badge widgets (`DurationBadge`) |
| `ui/components/excerpt/` | `ExcerptCard` — shared audio/video excerpt card |
| `ui/components/selectors/` | Generic selector dialogs (`SelectorDialog`, `ListItemSelectorDialog`, `MultiListItemSelectorDialog`) + `composables/` |
| `ui/components/tracks/list/` | Track list item + container (`TrackListItem`, `TracksList`, `TrackHeader`, `TrackMetaLine`; takes `UiTrackRow` mirror type) |
| `ui/components/tracks/search/input/` | Cross-platform search input (`SearchInput` + iOS/Android variants) |
| `ui/components/tracks/state/` | Track state indicators (`IconIndicator`, `RadialIndicator`, `TrackStateIndicator`) |
| `ui/features/activity/` | Listening-activity heatmap + streak/completed badges (driven by listening sessions) |
| `ui/features/collections/` | Library collections surface: `CollectionCard`, `CollectionListItem`, `CollectionsCarousel`, `CarouselSection`, `TileSection`, `LibraryBanner`, `AuthorAvatar`, `SectionHeader` |
| `ui/features/help/` | In-app Help dialog and its `pages/` |
| `ui/features/notes/` | Note list item + editor |
| `ui/features/player/` | Audio player controls, waveform, seek, mix control |
| `ui/features/playlist/` | Playlist items, swipes, progress bars, starter packs |
| `ui/features/settings/` | Settings items (app language, server, notifications, toggles) + grouped sections in `groups/` |
| `ui/features/subscription/` | Pro subscription / paywall surface |
| `ui/features/tracks/` | `TrackLanguageSelector` + `search/` filter chips (authors, sources, languages, duration, tags) |
| `ui/features/transcript/` | Transcript viewer (paragraph/sentence/verse blocks) + selection popover + `composables/` |

> **Adapter naming.** Most infra adapters are split by platform
> (`capacitor/` vs `web/`). Two exception categories:
>
> - **Single cross-platform plugin adapters**: `infra/audio/capacitor/`
>   and `infra/mediaDownloader/plugin/`. The plugin itself handles the
>   web fallback, so we ship one adapter instead of two.
> - **Engine-named persistence adapters**: `infra/persistence/sqljs/`
>   (sql.js) and `infra/persistence/fetchers/idb/` (IndexedDB) are
>   web-only by construction; `infra/persistence/fetchers/fs/`
>   (filesystem) is native-only. Naming follows the storage engine, not
>   the platform, because the engine is the load-bearing distinction.

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
`shruti/composables/`) is the **one place** that converts domain
inputs into these UI types. Adding a new surface field means: update the
domain type, update its mirror, update the builder, update the template
— in that order.

### `shruti/` — Composition Root + Driving Adapters

| | |
|---|---|
| **Path** | `modules/apps/mobile/shruti/` |
| **Role** | Wire everything together (shruti.ts), define routes, host Vue views |
| **May import** | Everything — this is the outermost layer |
| **Contains** | `shruti.ts` (singleton, lazy `repositories()`), `repositories.ts` (the `AppRepositories` bundle factory), `main.ts`, `App.vue`, `router/`, `composables/`, `stores/`, `services/`, `proactive/`, `chat/`, `components/`, `notifications/`, `utils/`, `i18n/`, `theme/`, `views/` (Welcome, Home, Search, Track, Tracks, Collection, Notes, Settings, Chat, Studio, Subscription, + `TabsLayout.vue`) |
| **Views** | Thin reactive shims that call use cases from `@usecases` and bind results to `@ui/*` components via controllers |

### `@lib/persistence/*` — DB Row Schemas

| | |
|---|---|
| **Path** | `modules/libs/persistence/main/`, `modules/libs/persistence/user/` |
| **Role** | TypeScript types for raw SQL row shapes. Infra concern, not domain. |
| **May import** | Nothing |
| **Used by** | Only `@infra/repositories/sql/` |

## Dependency Rule

**Imports flow inward/downward only. Siblings at the same layer never
import each other.**

```
shruti/  →  @ui, @infra, @ports, @usecases, @lib/domain, @lib/contracts, @kit
@ui/*       →  @kit/ui (shared primitives), @lib/ui (shared components), lower UI sub-layers only
@infra/*    →  @ports, @lib/domain, @lib/contracts, @lib/persistence, @kit (incl @kit/infra), @shruti/plugin-*
@usecases   →  @lib/domain, @lib/contracts, @kit
@lib/domain →  @kit, @lib/contracts
@ports/app  →  @kit (re-exports some kit/infra interface types); nothing else
@lib/contracts  →  (nothing)   ·   @kit/{core,servers}  →  (nothing)
```

### How to Verify

```bash
# No cross-feature imports inside @ui/features (promote shared widgets
# to @ui/components/):
grep -rn 'from "@ui/features/' ui/features/

# No @infra inside @ui or @ports:
grep -rn 'from "@infra/' ui/ ports/

# Domain is pure (domain + persistence are symlinked into the mobile app
# under submodules/, which is where ESLint matches them; the application
# layer lives in the app's own top-level usecases/).
# The only allowed non-domain imports are the shared kernel
# (@kit/*, @lib/contracts):
grep -rn 'from "@' submodules/domain/ | grep -vE '@lib/domain|@lib/contracts|@kit'

# Application depends on domain + shared kernel only:
grep -rn 'from "@' usecases/ | grep -vE '@lib/domain|@lib/contracts|@kit|@usecases'

# Row types only in repositories/sql:
grep -rn '@lib/persistence/' infra/ | grep -v 'repositories/sql'
```

ESLint's `no-restricted-imports` enforces **most** of these rules at lint time
— see `eslint.config.js` in the mobile app. The layer-boundary rule blocks key
on these paths: `submodules/domain/**`, `submodules/contracts/**`,
`submodules/persistence-*/**`, `usecases/**` (the application layer),
`ports/**`, `infra/**`, and per-sub-layer
`ui/{primitives,icons,components,features}/**`. Each UI sub-layer has its own
rule block that encodes the allowed downward imports. One carve-out worth
noting: infra may import the in-house `@shruti/plugin-*` packages (the
Capacitor plugins share the `@shruti` npm scope). `@lib/ui` is the only
`@lib/*` the UI may reach — every other shared library is banned by the same
blocks, because a sibling carries domain, wire or parsing code into a view.
Note `@kit/*` is *not*
restricted by these rules — it is the shared kernel/toolkit and may be
imported by every layer.

**`@lib/ui` has its own block.** The shared UI package
(`modules/libs/ui/`, symlinked into the app as `submodules/ui/` and aliased
`@lib/ui`) is a second, cross-app UI body that the `ui/**` globs do not match,
so it carries a rule block of its own keyed on `submodules/ui/**` /
`../../libs/ui/**` — the in-repo UI bans plus `@ui/*` and `@ionic/*`, because
the Astro web app renders the same components and ships no Ionic. See
[Shared UI library](../components/lib-ui.md).

**Known gap: the symlinked libs are only linted when named.** `eslint .` walks
the tree itself and does **not** descend through a symlinked directory, so any
block keyed on `submodules/**` is inert during a plain `eslint .`. The mobile
`lint` script works around this for one path — it passes `submodules/ui` as an
explicit second target — but the `contracts`, `domain` and `persistence-*`
blocks are still never evaluated. Treat the grep checks above as the real
boundary check for those three.

## Error-Handling Policy

Errors are handled differently depending on which layer raised them. The rule
of thumb: **views never see raw exceptions from use cases**.

| Layer | Strategy | Rationale |
|---|---|---|
| `@lib/domain` | Pure functions. Throw only on programmer error / impossible states. Use `Result<T, E>` for domain-level validation failures. | The domain is deterministic; a thrown error here is always a bug. |
| `@usecases` | Return `Result<T, E>` for recoverable failures (not found, stale state, conflict). Let `@infra` exceptions propagate only if the use case has no meaningful fallback — the composition-root wrapper will catch them. | Views must be able to discriminate `ok` vs `error` branches without try/catch. |
| `@infra/*` | Throw on data-invariant violations. May throw on platform failures (DB locked, file missing) — these are caught and mapped to `Result.error` inside application use cases or the view controller. | Invariant violations are bugs, not recoverable errors, and should surface loudly during development. |
| `@ui/*` | Never catches **use-case or resolver errors** — those must propagate to the view controller. Narrow carve-out: browser-platform lifecycle quirks (e.g. `HTMLAudioElement.play()` rejecting when autoplay is blocked). | UI is a pure renderer for application state; only per-component browser quirks belong inside it. |
| `shruti/` (views + controllers) | Catch exceptions from use cases at the outermost edge and map them to view state (e.g. `screen: "error"`). | Last line of defense before the user sees a blank screen. |

**In practice:**

- A domain entity throws `"impossible state"` → it is a bug; fix the caller.
- A use case calls a repository that throws `"row inconsistent"` → the view
  controller catches it, logs it, shows an error screen. No retry.
- A use case tries to load a non-existent track → returns
  `{ ok: false, error: "not-found" }` — the view branches on the error tag.

`Result<T, E>` (with `ok` / `err`) is defined in the shared kernel — `@kit/core` (`modules/kit/src/core/`) — so the domain, application, and infra all share one `Result` type. Prefer string
literal unions for the `E` type so TypeScript can narrow on the tag.

### `Result<T, E>` vs thrown — which use cases use which?

| Category | Pattern | Examples |
|---|---|---|
| **Mutation** use cases (create / update / delete / archive) | Return `Result<T, E>` with a string-literal error union — callers branch on recoverable domain errors like `not-found`, `already-archived`, `invalid-range`. | `addTrackToPlaylist`, `archivePlaylistItem`, `createNote`, `updateNote` (`not-found`/`invalid-range`), `deleteNote` (`not-found`), `loadTrackDetail` (`not-found`) |
| **Query** use cases (list / search / load) | Return the result directly (`readonly T[]` or the loaded entity). Throw on infra failure (DB unopen, SQL error) — the composition-root wrapper catches it. `Result` is used only when there is a meaningful domain-level branch the UI needs to render differently. | `searchAndFilterTracks`, `searchNotes`, `listActivePlaylistTracks`, `loadTrackDetail`, `getActivityOverview` return raw; `loadTranscript` returns `Result` because `no-transcript-available` vs `fetch-failed` need different UI treatments. |

The practical rule: **if the caller can do something different for each error
tag, use `Result`**. If every failure is just "something went wrong", throw and
let the controller render a generic error.

## Decision Tree: Where Does New Code Go?

```
Is it a pure business rule, entity, or value object?
  └─ YES → @lib/domain/

Is it a workflow that orchestrates domain logic + repository ports?
  └─ YES → @usecases/ (modules/apps/mobile/usecases/)

Is it a contract/interface for talking to infrastructure?
  └─ YES → @ports/app/

Does it implement a port (SQL, filesystem, HTTP, platform SDK)?
  └─ YES → @infra/<adapter-name>/

Is it a reusable UI component with props+events, no business logic?
  └─ YES → @ui/primitives/ (atomic, no-dep)
          or @ui/components/<area>/ (generic widget — used by multiple features)
          or @ui/features/<area>/ (specific to one feature surface)

Is it a Vue composable that wires stores / use cases / services?
  └─ YES → shruti/composables/

Is it a Vue view, a route, or app-level wiring?
  └─ YES → shruti/
```

## Composition Root Pattern

`shruti/shruti.ts` is the only file that knows every concrete adapter.
It exposes a `repositories()` method that lazily builds the SQL repository
bundle on first call (after databases are opened by the Welcome view):

```ts
const app = useShruti()
const repos = app.repositories()
// { tracks, authors, sources, locations, languages, tags, topics, transcripts,
//   notes, playlistItems, listeningSessions, mediaItems, collections,
//   chatSessions, chatMessages, proactiveState, unitOfWork }
```

View controllers call `app.repositories()` and interact with the domain
through repository ports — never through `IDatabase` or raw SQL directly.
