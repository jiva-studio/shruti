import type { Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import type {
  AuthPort,
  IAudioPlayer,
  IDatabase,
  IDatabaseFetcher,
  IDatabaseTransfer,
  IExcerptCache,
  IHaptics,
  IMediaDownloader,
  INotificationScheduler,
  IPersistence,
  IPreferences,
  IPurchases,
  IRemoteFilesStorage,
  IServerProber,
  IShareAudioService,
  IShareService,
  IShareTranscriptService,
  IShareVideoService,
  IStoragePublicUrl,
} from "@ports/app/index.js"
import type {
  IProactiveChatService,
  ISyncClient,
  IIngestClient,
  IDiscoveryClient,
} from "@lib/contracts"
import type { AppRepositories } from "@shruti/repositories.js"
import type { createStallGuard } from "@infra/watchDownload.js"
import type { createJsonRemoteStorage } from "@kit/infra"
import type { createHttpChatStreamClient } from "@infra/chat/http/httpChatStreamClient.js"
import type { createHttpChatTitleService } from "@infra/chat/http/httpChatTitleService.js"
import type { createHttpChatQuestionsService } from "@infra/chat/http/httpChatQuestionsService.js"
import type { createHttpChatFeedbackService } from "@infra/chat/http/httpChatFeedbackService.js"
import type { createHttpChatResumeService } from "@infra/chat/http/httpChatResumeService.js"

/**
 * App-wide config passed into `initShruti`. Built from `DEFAULT_APP_CONFIG`
 * in services/app.config.ts.
 */
export interface AppConfig {
  readonly database: {
    /** Path template for the content DB local copy. `{version}` is substituted. */
    readonly localPathTemplate: string
    /** Path template for the remote content DB (relative to bucket root). */
    readonly remotePathTemplate: string
    /** Local path for the user DB. */
    readonly userLocalPath: string
  }
  /** Path to the remote config manifest (relative to bucket root). */
  readonly publicRemoteConfigPath: string
}

/**
 * Composition root. The single place that knows every concrete adapter.
 * Populated by `initShruti`. Views reach it via `useShruti()`.
 */
export interface Shruti {
  readonly appConfig: AppConfig
  readonly persistence: IPersistence
  readonly databaseFetcher: IDatabaseFetcher
  readonly filesStorage: IRemoteFilesStorage
  /** Remote JSON over `filesStorage`. Bound here so a caller does not build an adapter. */
  readonly remoteJson: ReturnType<typeof createJsonRemoteStorage>
  /** Aborts a transfer that stops progressing. Bound here, not built by a caller. */
  readonly createStallGuard: typeof createStallGuard
  readonly storagePublicUrl: IStoragePublicUrl
  readonly preferences: IPreferences
  /**
   * Enumerates the keys `preferences` holds — the one question the port itself
   * does not answer. Read by the sync engine's origin recovery, which
   * looks for per-account markers whose ids it cannot name. Optional: absent ⇒
   * the recovery has no identity history to inspect and stays conservative.
   */
  readonly preferenceKeys?: () => Promise<readonly string[]>
  readonly audioPlayer: IAudioPlayer
  readonly notifications: INotificationScheduler
  readonly shareService: IShareService
  /**
   * Cloud-side share-audio cutter. Constructed locally inside
   * `initShruti` (no seed entry) — it only needs a getter over the
   * `activeServer` ref to pick the per-region endpoint at call time.
   */
  readonly shareAudioService: IShareAudioService
  /**
   * Cloud-side share-video reel renderer. Same lazy-getter wiring as
   * `shareAudioService` — picks the per-region endpoint at call time.
   */
  readonly shareVideoService: IShareVideoService
  /**
   * Cloud-side transcript-PDF renderer (share-transcript). Same lazy
   * per-region getter as shareAudioService; the client appends `/pdf`.
   */
  readonly shareTranscriptService: IShareTranscriptService
  /**
   * Per-note excerpt cache (Filesystem stat / downloadFile + HEAD
   * probe). Hides the Capacitor + fetch choreography from the Notes
   * share workflow.
   */
  readonly excerptCache: IExcerptCache
  readonly haptics: IHaptics
  readonly mediaDownloader: IMediaDownloader
  readonly purchases: IPurchases
  readonly serverProber: IServerProber
  /** Shruti auth service. Bootstraps anonymous-by-device on first launch;
   *  Settings can upgrade to Google / Apple later. */
  readonly auth: AuthPort
  /** Failover-aware HTTP client for the chat service. Consumers (chat
   *  store, title/questions/feedback services) call it with a path
   *  relative to the active server's `chatBaseUrl`. The composition
   *  root wires this through `createFailoverClient` so an unreachable
   *  preferred server transparently falls through to others. */
  readonly chatHttpRequest: (path: string, init?: RequestInit) => Promise<Response>
  /** HTTP/SSE adapter for `kind=proactive` chat turns. Used by the
   *  scheduler's content builders for `holiday`, `weekly_digest` and
   *  `inactivity` rules. */
  readonly proactiveChat: IProactiveChatService
  /** Chat service adapters (SSE/HTTP). Built in the composition root from
   *  `auth` + `chatHttpRequest` so the chat store consumes them instead of
   *  instantiating concrete @infra adapters itself. */
  readonly chatStreamClient: ReturnType<typeof createHttpChatStreamClient>
  readonly chatTitleService: ReturnType<typeof createHttpChatTitleService>
  readonly chatQuestionsService: ReturnType<typeof createHttpChatQuestionsService>
  readonly chatFeedbackService: ReturnType<typeof createHttpChatFeedbackService>
  readonly chatResumeService: ReturnType<typeof createHttpChatResumeService>
  /**
   * Profile device↔server sync transport (Lane D). The `useSyncEngine`
   * composable hands this to `runSync` only when the account is signed-in and
   * the active region has a `profileBaseUrl`; otherwise the engine is disabled.
   * Always constructed (it is stateless) — the runtime gate lives in the
   * composable, not here.
   */
  readonly syncClient: ISyncClient
  /**
   * Orchestrator ingest control-plane transport (POST /orchestrator/run,
   * GET /orchestrator/run/{id}). The library store drives it for direct
   * add/retry and live status polling.
   */
  readonly ingestClient: IIngestClient
  /**
   * Discovery search transport (POST /discovery/search) — the index of lectures
   * published on archives we do not own. The search surface drives it.
   */
  readonly discoveryClient: IDiscoveryClient
  /**
   * Resolves this device's stable id (Capacitor `Device.getId()`) — the HLC
   * tiebreak, the `sync_state` key, and the pull `X-Device-Id`. Wiring it also
   * turns on the sync-journal decorator + engine repositories in the bundle.
   */
  readonly getDeviceId: () => Promise<string>
  /** Native Filesystem+Share / web Blob+IDB adapter for exporting / importing
   * the user database. Wired with a `() => databases.user` closure so the
   * user DB doesn't have to be open at app-bootstrap time. */
  readonly databaseTransfer: IDatabaseTransfer
  /** Runtime platform, captured at bootstrap. Drives layout constants that can't be inferred from CSS. */
  readonly platform: "ios" | "android" | "web"

  /** Active CDN server; mutable via setActiveServer. */
  readonly activeServer: Ref<CdnServer>

  /**
   * Basename of the currently-open content DB (e.g.
   * "shruti.20260419210656.db"), captured by `openContentDatabase`.
   * Settings displays it; null until the Welcome flow runs.
   */
  readonly contentDbFile: Ref<string | null>

  /** Open database handles; filled by the Welcome view. */
  databases: {
    content: IDatabase | null
    user: IDatabase | null
  }

  setActiveServer(server: CdnServer): void
  /**
   * Resolve `serverId` against the runtime region registry
   * (regionsRegistry) and activate it. Used by the Welcome flow after
   * `IServerProber.probe` returns the chosen server's id.
   */
  setActiveServerById(serverId: string): void

  openContentDatabase(path: string): Promise<IDatabase>
  closeContentDatabase(): Promise<void>
  openUserDatabase(path: string): Promise<IDatabase>
  /**
   * Drop the user database handle (and the repositories built over it).
   * Used when its bootstrap failed: a handle onto a database the app could
   * not migrate — or could not read at all — is worse than none, because
   * `repositories()` would hand it out and every write would fail silently.
   */
  closeUserDatabase(): Promise<void>

  /**
   * Lazily constructed bundle of domain-facing repositories. Callable only
   * after **both** databases are open (the Welcome view opens them in
   * phases 2 and 3). Cached on first call.
   */
  repositories(): AppRepositories

  /**
   * Read the scheme version recorded by the last `migrations` row of the
   * open content DB. Throws if the content DB isn't open.
   */
  readContentSchemeVersion(): Promise<number>
}

export interface InitShrutiSeed {
  readonly appConfig: AppConfig
  readonly persistence: IPersistence
  readonly databaseFetcher: IDatabaseFetcher
  readonly filesStorage: IRemoteFilesStorage
  readonly preferences: IPreferences
  /** See {@link Shruti.preferenceKeys}. */
  readonly preferenceKeys?: () => Promise<readonly string[]>
  readonly audioPlayer: IAudioPlayer
  readonly notifications: INotificationScheduler
  readonly shareService: IShareService
  readonly haptics: IHaptics
  readonly mediaDownloader: IMediaDownloader
  readonly purchases: IPurchases
  readonly serverProber: IServerProber
  readonly excerptCache: IExcerptCache
  readonly auth: AuthPort
  readonly chatHttpRequest: (path: string, init?: RequestInit) => Promise<Response>
  readonly proactiveChat: IProactiveChatService
  /** Profile-sync transport (Lane D). */
  readonly syncClient: ISyncClient
  /** Orchestrator ingest control-plane transport (add/retry + live status). */
  readonly ingestClient: IIngestClient
  /** Discovery search transport — lectures on archives we do not own. */
  readonly discoveryClient: IDiscoveryClient
  /** Stable device-id provider; enables journaling + the sync engine repos. */
  readonly getDeviceId: () => Promise<string>
  /** Factory invoked inside `initShruti` with a `() => databases.user`
   * getter. The factory pattern keeps the circular dependency local — the
   * adapter would otherwise need to close over a not-yet-built `Shruti`. */
  readonly databaseTransferFactory: (getUserDb: () => IDatabase | null) => IDatabaseTransfer
  readonly platform: "ios" | "android" | "web"
  /** First server to try; the Welcome view may swap it after probing. */
  readonly initialServer: CdnServer
}
