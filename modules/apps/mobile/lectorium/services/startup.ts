import {
  createBootstrapController,
  type BootstrapController,
  type ProbeResult,
  type ResolveContentDatabaseOptions,
} from "@kit/bootstrap"
import { useLectorium } from "@lectorium/lectorium.js"
import { bootstrapUserDatabaseFromApp } from "@lectorium/services/bootstrap.js"
import { PREFERRED_SERVER_KEY } from "@lectorium/services/preferredServer.js"
import { findRegion, getRegions, setRegions } from "@lectorium/services/regionsRegistry.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"

/**
 * DB scheme this client is built against. Source of truth is
 * `modules/db-scheme.json`, injected via Vite `define`.
 */
declare const __DB_SCHEME__: number
const SUPPORTED_DB_SCHEME = __DB_SCHEME__

/**
 * Headless Lectorium bootstrap. Builds the generic kit Stale-While-Revalidate
 * controller with the Lectorium-specific ports (composition root, region
 * registry, preferences). No Vue, no UI, no navigation — startup runs this
 * before mount so the databases are already open when the first view renders.
 *
 * The DB ships bundled in the app (offline-first copy-from-assets in the
 * fetcher), so the first launch opens instantly with no foreground download
 * and no loading screen. `scheduleBackgroundRefresh` then fetches a newer
 * catalog for the next launch.
 */
export function createLectoriumBootstrap(): BootstrapController<unknown> {
  const lectorium = useLectorium()

  function applyRemoteRegions(config: RemoteAppConfig): void {
    if (!config.regions) return
    if (!setRegions(config.regions)) return
    const activeId = lectorium.activeServer.value.id
    const targetId = findRegion(activeId) ? activeId : getRegions()[0]!.id
    lectorium.setActiveServerById(targetId)
  }

  function buildResolveOptions(
    incompatibleDbPaths: ReadonlySet<string>
  ): ResolveContentDatabaseOptions<RemoteAppConfig> {
    return {
      store: lectorium.databaseFetcher,
      probe: async (configPath, preferredServerId) => {
        const result = await lectorium.serverProber.probe(
          configPath,
          preferredServerId ?? undefined
        )
        return {
          server: findRegion(result.serverId) ?? getRegions()[0]!,
          config: result.config as RemoteAppConfig,
        } satisfies ProbeResult<RemoteAppConfig>
      },
      configPath: lectorium.appConfig.publicRemoteConfigPath,
      remotePathTemplate: lectorium.appConfig.database.remotePathTemplate,
      localPathTemplate: lectorium.appConfig.database.localPathTemplate,
      supportedScheme: SUPPORTED_DB_SCHEME,
      incompatibleDbPaths,
      preferredServerId: lectorium.activeServer.value.id,
      onServerResolved: (probe) => lectorium.setActiveServerById(probe.server.id),
      onConfigResolved: applyRemoteRegions,
    }
  }

  return createBootstrapController<RemoteAppConfig, unknown>({
    supportedScheme: SUPPORTED_DB_SCHEME,
    buildResolveOptions,
    openContentDatabase: (path) => lectorium.openContentDatabase(path),
    closeContentDatabase: () => lectorium.closeContentDatabase(),
    readContentSchemeVersion: () => lectorium.readContentSchemeVersion(),
    deleteLocalDatabase: (path) => lectorium.databaseFetcher.delete(path),
    invalidateConfigCache: () =>
      lectorium.filesStorage.delete(
        lectorium.storagePublicUrl.get(lectorium.appConfig.publicRemoteConfigPath)
      ),
    // Open the user DB + run pending user migrations. Never let a user-DB
    // failure brick the app — the catalog is fully browsable without it; the
    // playlist / notes / chat-history stores degrade on their own.
    runUserDatabaseMigrations: async () => {
      try {
        await bootstrapUserDatabaseFromApp(lectorium)
      } catch (err) {
        console.error(
          "[lectorium] user-DB bootstrap/migration failed; continuing in a degraded state:",
          err
        )
      }
    },
    onBackgroundRefreshComplete: () => {
      void lectorium.preferences.set(PREFERRED_SERVER_KEY, lectorium.activeServer.value.id)
    },
    onBackgroundRefreshError: (err) => {
      console.warn("[lectorium] background content refresh failed:", err)
    },
  })
}

export interface StartupResult {
  ready: boolean
  error: string | null
}

/**
 * Run the bootstrap to completion (or failure). Returns whether the databases
 * are open. With the bundled DB this resolves near-instantly and offline on
 * first launch; on later launches it opens the cached DB and kicks off a
 * silent background refresh for the next launch.
 */
export async function runStartupBootstrap(): Promise<StartupResult> {
  const controller = createLectoriumBootstrap()
  try {
    await controller.start()
  } catch (err) {
    return { ready: false, error: err instanceof Error ? err.message : String(err) }
  }
  return {
    ready: controller.isReady.value,
    error: controller.error.value,
  }
}
