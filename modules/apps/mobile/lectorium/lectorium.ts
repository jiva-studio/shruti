import { ref, type Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import type {
  IAudioPlayer,
  IDatabase,
  IDatabaseFetcher,
  IHaptics,
  IMediaDownloader,
  INotificationScheduler,
  IPersistence,
  IPreferences,
  IRemoteFilesStorage,
  IShareService,
  IStoragePublicUrl,
} from "@ports/app/index.js"
import { createAppRepositories, type AppRepositories } from "./repositories.js"
import { useStoragePublicUrl } from "@infra/storage.public.url/index.js"
import { probeServers as probeServersImpl, type ServerProbeResult } from "@infra/servers/index.js"
import { createSqlSchemeVersionRepository } from "@infra/repositories.sql/index.js"

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
  readonly servers: readonly CdnServer[]
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
  readonly haptics: IHaptics
  readonly mediaDownloader: IMediaDownloader
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
   * Probe CDN servers for `configPath`; returns the first reachable one
   * plus the parsed remote config. Wraps `@infra/servers/probeServers`
   * so the Welcome view doesn't reach into infra directly.
   */
  probeServers(configPath: string, preferredServerId?: string): Promise<ServerProbeResult>

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
  readonly platform: "ios" | "android" | "web"
  /** First server to try; the Welcome view may swap it after probing. */
  readonly initialServer: CdnServer
}

let instance: Lectorium | null = null

export function initLectorium(seed: InitLectoriumSeed): Lectorium {
  if (instance) throw new Error("Lectorium already initialized")

  const activeServer = ref<CdnServer>(seed.initialServer)
  const contentDbFile = ref<string | null>(null)
  const databases: Lectorium["databases"] = { content: null, user: null }
  let cachedRepos: AppRepositories | null = null

  // `useStoragePublicUrl` is the canonical adapter — a thin
  // `{path}`-substitution function. We feed it a getter closure so
  // the resolver always sees the latest CDN template after
  // `setActiveServer` swaps it.
  const storagePublicUrl: IStoragePublicUrl = useStoragePublicUrl(
    () => activeServer.value
  )

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
    haptics: seed.haptics,
    mediaDownloader: seed.mediaDownloader,
    platform: seed.platform,
    activeServer,
    contentDbFile,
    databases,

    setActiveServer(server) {
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
      cachedRepos = createAppRepositories({
        contentDb: databases.content,
        userDb: databases.user,
        filesStorage: seed.filesStorage,
        storagePublicUrl,
      })
      return cachedRepos
    },

    probeServers(configPath, preferredServerId) {
      return probeServersImpl(configPath, preferredServerId)
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
