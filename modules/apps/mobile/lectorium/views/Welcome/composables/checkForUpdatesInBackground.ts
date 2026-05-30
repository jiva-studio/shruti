import type { IDatabaseFetcher, IServerProber, ServerProbeResult } from "@ports/app/index.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"
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
  serverProber: IServerProber
  onServerResolved(result: ServerProbeResult): void
  applyRemoteConfig(config: RemoteAppConfig): void
  loadSavedPreferredServerId(): Promise<string | undefined>
  persistPreferredServerIdIfChanged(resolvedId: string): void
}

export async function checkForUpdatesInBackground(deps: CheckForUpdatesDeps): Promise<void> {
  try {
    const preferredId = await deps.loadSavedPreferredServerId()
    const probeResult = await deps.serverProber.probe(
      deps.config.publicRemoteConfigPath,
      preferredId
    )
    deps.onServerResolved(probeResult)

    const config = probeResult.config as RemoteAppConfig
    deps.applyRemoteConfig(config)
    const latestVersion = findLatestCompatibleVersion(deps, config)
    if (!latestVersion) return

    const databaseStoragePath = buildDatabaseStoragePath(deps, latestVersion)
    const dbExists = await deps.databaseFetcher.exists(databaseStoragePath)
    if (dbExists) return

    const databaseUrl = buildDatabaseUrl(deps, latestVersion)
    await deps.databaseFetcher.download(databaseUrl, databaseStoragePath)

    deps.persistPreferredServerIdIfChanged(probeResult.serverId)
  } catch {
    // Offline or CDN error — silently ignore
  }
}
