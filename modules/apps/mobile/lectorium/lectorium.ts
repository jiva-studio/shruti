import { ref, type Ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import type {
  IDatabase,
  IDatabaseFetcher,
  IPersistence,
  IPreferences,
  IRemoteFilesStorage,
  IStoragePublicUrl,
} from "@ports/app/index.js"
import {
  createAppRepositories,
  type AppRepositories,
} from "@infra/repositories.sql/index.js"

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

  /** Active CDN server; mutable via setActiveServer. */
  readonly activeServer: Ref<CdnServer>

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
}

export interface InitLectoriumSeed {
  readonly appConfig: AppConfig
  readonly persistence: IPersistence
  readonly databaseFetcher: IDatabaseFetcher
  readonly filesStorage: IRemoteFilesStorage
  readonly preferences: IPreferences
  /** First server to try; the Welcome view may swap it after probing. */
  readonly initialServer: CdnServer
}

let instance: Lectorium | null = null

export function initLectorium(seed: InitLectoriumSeed): Lectorium {
  if (instance) throw new Error("Lectorium already initialized")

  const activeServer = ref<CdnServer>(seed.initialServer)
  const databases: Lectorium["databases"] = { content: null, user: null }
  let cachedRepos: AppRepositories | null = null

  const storagePublicUrl: IStoragePublicUrl = {
    get: (path: string) => activeServer.value.urlTemplate.replace("{path}", path),
  }

  const self: Lectorium = {
    appConfig: seed.appConfig,
    persistence: seed.persistence,
    databaseFetcher: seed.databaseFetcher,
    filesStorage: seed.filesStorage,
    storagePublicUrl,
    preferences: seed.preferences,
    activeServer,
    databases,

    setActiveServer(server) {
      activeServer.value = server
    },

    async openContentDatabase(path) {
      if (databases.content) await databases.content.close()
      const db = await seed.persistence.open(path)
      databases.content = db
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
  }

  instance = self
  return self
}

export function useLectorium(): Lectorium {
  if (!instance) throw new Error("Lectorium not initialized — call initLectorium first")
  return instance
}

/** Test-only hook: resets the singleton between test cases. */
export function __resetLectoriumForTests(): void {
  instance = null
}
