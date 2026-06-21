import {
  createBootstrapController,
  type BootstrapController,
  type ProbeResult,
  type ResolveContentDatabaseOptions,
} from "@kit/bootstrap"
import { useShruti } from "@shruti/shruti.js"
import { bootstrapUserDatabaseFromApp } from "@shruti/services/bootstrap.js"
import { PREFERRED_SERVER_KEY } from "@shruti/services/preferredServer.js"
import { findRegion, getRegions, setRegions } from "@shruti/services/regionsRegistry.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"

/**
 * DB scheme this client is built against. Source of truth is
 * `modules/db-scheme.json`, injected via Vite `define`.
 */
declare const __DB_SCHEME__: number
const SUPPORTED_DB_SCHEME = __DB_SCHEME__

/**
 * Headless Shruti bootstrap. Builds the generic kit Stale-While-Revalidate
 * controller with the Shruti-specific ports (composition root, region
 * registry, preferences). No Vue, no UI, no navigation — startup runs this
 * before mount so the databases are already open when the first view renders.
 *
 * The DB ships bundled in the app (offline-first copy-from-assets in the
 * fetcher), so the first launch opens instantly with no foreground download
 * and no loading screen. `scheduleBackgroundRefresh` then fetches a newer
 * catalog for the next launch.
 */
export function createShrutiBootstrap(): BootstrapController<unknown> {
  const shruti = useShruti()

  function applyRemoteRegions(config: RemoteAppConfig): void {
    if (!config.regions) return
    if (!setRegions(config.regions)) return
    const activeId = shruti.activeServer.value.id
    const targetId = findRegion(activeId) ? activeId : getRegions()[0]!.id
    shruti.setActiveServerById(targetId)
  }

  function buildResolveOptions(
    incompatibleDbPaths: ReadonlySet<string>
  ): ResolveContentDatabaseOptions<RemoteAppConfig> {
    return {
      store: shruti.databaseFetcher,
      probe: async (configPath, preferredServerId) => {
        const result = await shruti.serverProber.probe(
          configPath,
          preferredServerId ?? undefined
        )
        return {
          server: findRegion(result.serverId) ?? getRegions()[0]!,
          config: result.config as RemoteAppConfig,
        } satisfies ProbeResult<RemoteAppConfig>
      },
      configPath: shruti.appConfig.publicRemoteConfigPath,
      remotePathTemplate: shruti.appConfig.database.remotePathTemplate,
      localPathTemplate: shruti.appConfig.database.localPathTemplate,
      supportedScheme: SUPPORTED_DB_SCHEME,
      incompatibleDbPaths,
      preferredServerId: shruti.activeServer.value.id,
      onServerResolved: (probe) => shruti.setActiveServerById(probe.server.id),
      onConfigResolved: applyRemoteRegions,
    }
  }

  return createBootstrapController<RemoteAppConfig, unknown>({
    supportedScheme: SUPPORTED_DB_SCHEME,
    buildResolveOptions,
    openContentDatabase: (path) => shruti.openContentDatabase(path),
    closeContentDatabase: () => shruti.closeContentDatabase(),
    readContentSchemeVersion: () => shruti.readContentSchemeVersion(),
    deleteLocalDatabase: (path) => shruti.databaseFetcher.delete(path),
    invalidateConfigCache: () =>
      shruti.filesStorage.delete(
        shruti.storagePublicUrl.get(shruti.appConfig.publicRemoteConfigPath)
      ),
    // Open the user DB + run pending user migrations. Never let a user-DB
    // failure brick the app — the catalog is fully browsable without it; the
    // playlist / notes / chat-history stores degrade on their own.
    runUserDatabaseMigrations: async () => {
      try {
        await bootstrapUserDatabaseFromApp(shruti)
      } catch (err) {
        console.error(
          "[shruti] user-DB bootstrap/migration failed; continuing in a degraded state:",
          err
        )
      }
    },
    onBackgroundRefreshComplete: () => {
      void shruti.preferences.set(PREFERRED_SERVER_KEY, shruti.activeServer.value.id)
    },
    onBackgroundRefreshError: (err) => {
      console.warn("[shruti] background content refresh failed:", err)
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
  const controller = createShrutiBootstrap()
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
