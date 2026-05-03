import type {
  IDatabaseFetcher,
  IRemoteFilesStorage,
  IServerProber,
  ServerProbeResult,
} from "@ports/app/index.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"
import {
  buildDatabaseStoragePath,
  buildDatabaseUrl,
  fetchConfigUncached,
  findLatestCompatibleVersion,
  findLocalDatabase,
  type DatabaseLocatorDeps,
} from "./databaseLocator.js"

/**
 * Phase 1 of the Welcome flow: produce a path to a usable content
 * database. Tries the local filesystem first (offline-first) and falls
 * back to a CDN probe + download when no cached DB is available or
 * the one we have got rejected by scheme validation earlier this
 * session (tracked via `incompatibleDbPaths`).
 *
 * Progress reporting is fed back through the view state setters so the
 * screen can animate between "server:probing" → "config:downloading" →
 * "database:check" / "database:downloading" without the caller having
 * to know the shape of the flow.
 */
export interface ResolveContentDatabaseDeps extends DatabaseLocatorDeps {
  databaseFetcher: IDatabaseFetcher
  filesStorage: IRemoteFilesStorage
  serverProber: IServerProber
  onServerResolved(result: ServerProbeResult): void
  loadSavedPreferredServerId(): Promise<string | undefined>
  setViewState(
    value: "server:probing" | "config:downloading" | "database:check" | "database:downloading"
  ): void
  setProgress(percent: number): void
}

export async function resolveContentDatabase(
  deps: ResolveContentDatabaseDeps,
  incompatibleDbPaths: ReadonlySet<string>
): Promise<string> {
  deps.setViewState("database:check")
  const localPath = await findLocalDatabase(deps, incompatibleDbPaths)
  if (localPath) return localPath

  return await fetchDatabaseFromCdn(deps)
}

async function fetchDatabaseFromCdn(deps: ResolveContentDatabaseDeps): Promise<string> {
  // Probe servers
  deps.setViewState("server:probing")
  const preferredId = await deps.loadSavedPreferredServerId()
  const probeResult = await deps.serverProber.probe(deps.config.publicRemoteConfigPath, preferredId)
  deps.onServerResolved(probeResult)

  // Resolve latest compatible version from config
  deps.setViewState("config:downloading")
  let config = probeResult.config as RemoteAppConfig
  let latestVersion = findLatestCompatibleVersion(deps, config)

  if (latestVersion === null) {
    // Cached config advertises no compatible DB — invalidate and re-fetch.
    const configUrl = deps.getPublicUrl(deps.config.publicRemoteConfigPath)
    await deps.filesStorage.delete(configUrl)
    config = await fetchConfigUncached(deps, configUrl)
    latestVersion = findLatestCompatibleVersion(deps, config)
  }
  if (latestVersion === null) {
    throw new Error(`No compatible database for scheme ${deps.supportedScheme}`)
  }

  const databaseUrl = buildDatabaseUrl(deps, latestVersion)
  const databaseStoragePath = buildDatabaseStoragePath(deps, latestVersion)

  deps.setViewState("database:check")
  const dbExists = await deps.databaseFetcher.exists(databaseStoragePath)

  if (!dbExists) {
    deps.setViewState("database:downloading")
    await deps.databaseFetcher.download(
      databaseUrl,
      databaseStoragePath,
      (receivedLength, totalLength) => {
        deps.setProgress(totalLength > 0 ? Math.round((receivedLength / totalLength) * 100) : 0)
      }
    )
  }

  return databaseStoragePath
}
