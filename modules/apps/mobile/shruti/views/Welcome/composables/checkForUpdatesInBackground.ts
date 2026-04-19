import type { IDatabaseFetcher } from "@ports/app/index.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"
import type { ServerProbeResult } from "@infra/servers/index.js"
import {
  buildDatabaseStoragePath,
  buildDatabaseUrl,
  findLatestCompatibleVersion,
  type DatabaseLocatorDeps,
} from "./databaseLocator.js"

/**
 * Fire-and-forget post-bootstrap refresh: probes the CDN for a newer
 * database version and downloads it alongside the current one. The new
 * file will be picked up on the next app launch by `findLocalDatabase()`
 * (lexicographic sort picks the latest).
 *
 * Runs after the app is fully loaded — never blocks the user. Any error
 * is swallowed because we're offline-tolerant; the app works fine with
 * yesterday's DB.
 */
export interface CheckForUpdatesDeps extends DatabaseLocatorDeps {
  databaseFetcher: IDatabaseFetcher
  probeServers(configPath: string, preferredId?: string): Promise<ServerProbeResult>
  onServerResolved(result: ServerProbeResult): void
  loadSavedPreferredServerId(): Promise<string | undefined>
  persistPreferredServerIdIfChanged(resolvedId: string): void
}

export async function checkForUpdatesInBackground(deps: CheckForUpdatesDeps): Promise<void> {
  try {
    const preferredId = await deps.loadSavedPreferredServerId()
    const probeResult = await deps.probeServers(deps.config.publicRemoteConfigPath, preferredId)
    deps.onServerResolved(probeResult)

    const config = probeResult.config as RemoteAppConfig
    const latestVersion = findLatestCompatibleVersion(deps, config)
    if (!latestVersion) return

    const databaseStoragePath = buildDatabaseStoragePath(deps, latestVersion)
    const dbExists = await deps.databaseFetcher.exists(databaseStoragePath)
    if (dbExists) return

    const databaseUrl = buildDatabaseUrl(deps, latestVersion)
    await deps.databaseFetcher.download(databaseUrl, databaseStoragePath)

    deps.persistPreferredServerIdIfChanged(probeResult.server.id)
  } catch {
    // Offline or CDN error — silently ignore
  }
}
