import { ref, watch, type Ref } from "vue"
import { type CdnServer } from "@lib/domain/servers.js"
import { findRegion, setActiveRegionId } from "./services/regionsRegistry.js"
import { PREFERRED_SERVER_KEY } from "./services/preferredServer.js"
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
import { createAppRepositories, type AppRepositories } from "./repositories.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useSyncChatsEnabled } from "@lectorium/composables/useSyncChats.js"
import { useStoragePublicUrl } from "@kit/infra"
import { useHttpShareAudioService } from "@infra/shareAudio/http/useHttpShareAudioService.js"
import { useHttpShareVideoService } from "@infra/shareVideo/http/useHttpShareVideoService.js"
import { useHttpShareTranscriptService } from "@infra/shareTranscript/http/useHttpShareTranscriptService.js"
import { createSqlSchemeVersionRepository } from "@infra/repositories/sql/index.js"
import { createHttpChatStreamClient } from "@infra/chat/http/httpChatStreamClient.js"
import { createHttpChatTitleService } from "@infra/chat/http/httpChatTitleService.js"
import { createHttpChatQuestionsService } from "@infra/chat/http/httpChatQuestionsService.js"
import { createHttpChatFeedbackService } from "@infra/chat/http/httpChatFeedbackService.js"
import { createHttpChatResumeService } from "@infra/chat/http/httpChatResumeService.js"

/**
 * App-wide config passed into `initLectorium`. Built from `DEFAULT_APP_CONFIG`
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
 * Populated by `initLectorium`. Views reach it via `useLectorium()`.
 */
export interface Lectorium {
  readonly appConfig: AppConfig
  readonly persistence: IPersistence
  readonly databaseFetcher: IDatabaseFetcher
  readonly filesStorage: IRemoteFilesStorage
  readonly storagePublicUrl: IStoragePublicUrl
  readonly preferences: IPreferences
  readonly audioPlayer: IAudioPlayer
  readonly notifications: INotificationScheduler
  readonly shareService: IShareService
  /**
   * Cloud-side share-audio cutter. Constructed locally inside
   * `initLectorium` (no seed entry) — it only needs a getter over the
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
  /** Lectorium auth service. Bootstraps anonymous-by-device on first launch;
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
   * Orchestrator ingest control-plane transport (POST /orchestrator/ingest,
   * GET /orchestrator/ingest/{id}). The library store drives it for direct
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
   * "lectorium.20260419210656.db"), captured by `openContentDatabase`.
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

export interface InitLectoriumSeed {
  readonly appConfig: AppConfig
  readonly persistence: IPersistence
  readonly databaseFetcher: IDatabaseFetcher
  readonly filesStorage: IRemoteFilesStorage
  readonly preferences: IPreferences
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
  /** Factory invoked inside `initLectorium` with a `() => databases.user`
   * getter. The factory pattern keeps the circular dependency local — the
   * adapter would otherwise need to close over a not-yet-built `Lectorium`. */
  readonly databaseTransferFactory: (getUserDb: () => IDatabase | null) => IDatabaseTransfer
  readonly platform: "ios" | "android" | "web"
  /** First server to try; the Welcome view may swap it after probing. */
  readonly initialServer: CdnServer
}

let instance: Lectorium | null = null

export function initLectorium(seed: InitLectoriumSeed): Lectorium {
  if (instance) throw new Error("Lectorium already initialized")

  const activeServer = ref<CdnServer>(seed.initialServer)
  // Mirror the active region into the registry so resolveAssetUrl (covers,
  // avatars) builds against the live region, not a hardcoded regions[0].
  setActiveRegionId(seed.initialServer.id)
  // Whenever activeServer flips, persist the id under PREFERRED_SERVER_KEY
  // so the next cold start lands on the same region. This collapses the
  // "set active" and "remember for next launch" knobs that used to live
  // as two separate functions (setActiveServerById + promotePreferredServer)
  // and caused subtle regressions whenever a new flow forgot to call both.
  // Welcome's initial swap doesn't need an early-exit guard: writing the
  // same id back to preferences is a no-op on disk.
  watch(activeServer, (next, prev) => {
    // Keep asset resolution pointed at the live region on every promotion.
    setActiveRegionId(next.id)
    if (next.id === prev.id) return
    void seed.preferences.set(PREFERRED_SERVER_KEY, next.id).catch((err) => {
      console.warn(`[lectorium] persist preferredServerId failed for ${next.id}`, err)
    })
  })
  const contentDbFile = ref<string | null>(null)
  const databases: Lectorium["databases"] = { content: null, user: null }
  let cachedRepos: AppRepositories | null = null

  // `useStoragePublicUrl` is the canonical adapter — a thin
  // `{path}`-substitution function. We feed it a getter closure so
  // the resolver always sees the latest CDN template after
  // `setActiveServer` swaps it.
  const storagePublicUrl: IStoragePublicUrl = useStoragePublicUrl(() => activeServer.value)

  // Same lazy-getter pattern as storagePublicUrl: resolves the
  // per-region cutter endpoint at call time, so a settings flip
  // routes subsequent share-audio calls to the new region.
  //
  // share-video also requires a Bearer token (per-user daily quota
  // enforced server-side). share-audio stays anonymous — its work is
  // cheap stream-copy, only Caddy edge rate-limit applies.
  const shareAudioService = useHttpShareAudioService(() => activeServer.value.shareAudioUrl)
  const shareVideoService = useHttpShareVideoService(
    () => activeServer.value.shareVideoUrl,
    () => seed.auth.getAccessToken()
  )
  // share-transcript base. A published config.json predating the field
  // omits it — derive from chatBaseUrl (share-* routes live behind the
  // same Caddy as chat) so old configs keep working.
  const shareTranscriptService = useHttpShareTranscriptService(
    () =>
      activeServer.value.shareTranscriptUrl ?? `${activeServer.value.chatBaseUrl}/share/transcripts`
  )

  // Chat service adapters. Built here (not in the chat store) so the
  // composition root stays the only place that knows concrete @infra
  // adapters. `chatAuthDeps` closes over the failover-aware HTTP client
  // and the auth token getter.
  const chatAuthDeps = {
    getAccessToken: () => seed.auth.getAccessToken(),
    request: seed.chatHttpRequest,
  }
  const chatStreamClient = createHttpChatStreamClient(chatAuthDeps)
  const chatTitleService = createHttpChatTitleService(chatAuthDeps)
  const chatQuestionsService = createHttpChatQuestionsService(chatAuthDeps)
  const chatFeedbackService = createHttpChatFeedbackService(chatAuthDeps)
  const chatResumeService = createHttpChatResumeService(chatAuthDeps)

  const self: Lectorium = {
    appConfig: seed.appConfig,
    persistence: seed.persistence,
    databaseFetcher: seed.databaseFetcher,
    filesStorage: seed.filesStorage,
    storagePublicUrl,
    preferences: seed.preferences,
    audioPlayer: seed.audioPlayer,
    notifications: seed.notifications,
    shareService: seed.shareService,
    shareAudioService,
    shareVideoService,
    shareTranscriptService,
    excerptCache: seed.excerptCache,
    haptics: seed.haptics,
    mediaDownloader: seed.mediaDownloader,
    purchases: seed.purchases,
    serverProber: seed.serverProber,
    auth: seed.auth,
    chatHttpRequest: seed.chatHttpRequest,
    proactiveChat: seed.proactiveChat,
    chatStreamClient,
    chatTitleService,
    chatQuestionsService,
    chatFeedbackService,
    chatResumeService,
    syncClient: seed.syncClient,
    ingestClient: seed.ingestClient,
    discoveryClient: seed.discoveryClient,
    getDeviceId: seed.getDeviceId,
    databaseTransfer: seed.databaseTransferFactory(() => databases.user),
    platform: seed.platform,
    activeServer,
    contentDbFile,
    databases,

    setActiveServer(server) {
      activeServer.value = server
    },

    setActiveServerById(serverId) {
      const server = findRegion(serverId)
      if (!server) throw new Error(`Unknown server id: ${serverId}`)
      activeServer.value = server
    },

    async openContentDatabase(path) {
      if (databases.content) await databases.content.close()
      const db = await seed.persistence.open(path)
      databases.content = db
      // Basename for display (Settings build-info line).
      const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
      contentDbFile.value = idx >= 0 ? path.substring(idx + 1) : path
      return db
    },

    async closeContentDatabase() {
      if (databases.content) {
        await databases.content.close()
        databases.content = null
      }
    },

    async openUserDatabase(path) {
      if (databases.user) return databases.user
      const db = await seed.persistence.open(path)
      databases.user = db
      return db
    },

    repositories() {
      if (cachedRepos) return cachedRepos
      if (!databases.content) {
        throw new Error("repositories(): content DB is not open yet")
      }
      if (!databases.user) {
        throw new Error("repositories(): user DB is not open yet")
      }
      const appLanguage = useAppLanguage()
      // Device-local "Sync chats" toggle (default ON); read live so a flip in
      // Settings gates the very next chat write without rebuilding repos.
      const syncChatsEnabled = useSyncChatsEnabled()
      cachedRepos = createAppRepositories({
        contentDb: databases.content,
        userDb: databases.user,
        filesStorage: seed.filesStorage,
        storagePublicUrl,
        getActiveLanguage: () => appLanguage.value,
        // Turns on the sync-journal decorator + the engine repositories.
        getDeviceId: seed.getDeviceId,
        // Read straight off the auth port, not the store: the port is the
        // source the store mirrors, so a row journaled during an account
        // switch is stamped with the identity that is actually in effect.
        getOwnerId: () => seed.auth.getSession()?.userId ?? null,
        isChatSyncEnabled: () => syncChatsEnabled.value,
      })
      return cachedRepos
    },

    async readContentSchemeVersion() {
      if (!databases.content) {
        throw new Error("readContentSchemeVersion(): content DB is not open yet")
      }
      return createSqlSchemeVersionRepository(databases.content).read()
    },
  }

  instance = self
  return self
}

export function useLectorium(): Lectorium {
  if (!instance) throw new Error("Lectorium not initialized — call initLectorium first")
  return instance
}

export function isLectoriumInitialized(): boolean {
  return instance !== null
}

/** Test-only hook: resets the singleton between test cases. */
export function __resetLectoriumForTests(): void {
  instance = null
}
