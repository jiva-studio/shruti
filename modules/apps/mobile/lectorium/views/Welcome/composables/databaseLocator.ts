import type { IDatabaseFetcher, IRemoteFilesStorage } from "@ports/app/index.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"

/**
 * Shared helpers used by both `resolveContentDatabase` (foreground startup
 * flow) and `checkForUpdatesInBackground` (post-bootstrap refresh). Extracted
 * so neither composable reaches back into the view controller for URL
 * arithmetic.
 */
export interface DatabaseLocatorConfig {
  readonly remotePathTemplate: string
  readonly localPathTemplate: string
  readonly publicRemoteConfigPath: string
}

export interface DatabaseLocatorDeps {
  readonly config: DatabaseLocatorConfig
  readonly supportedScheme: number
  getPublicUrl(path: string): string
  filesStorage: Pick<IRemoteFilesStorage, "get" | "getJson" | "delete">
  databaseFetcher: Pick<IDatabaseFetcher, "list">
}

export function buildDatabaseUrl(deps: DatabaseLocatorDeps, version: number): string {
  const path = deps.config.remotePathTemplate.replace("{version}", String(version))
  return deps.getPublicUrl(path)
}

export function buildDatabaseStoragePath(deps: DatabaseLocatorDeps, version: number): string {
  return deps.config.localPathTemplate.replace("{version}", String(version))
}

export function findLatestCompatibleVersion(
  deps: DatabaseLocatorDeps,
  config: RemoteAppConfig
): number | null {
  const compatible = (config.databases ?? []).filter(
    (db) => (db.scheme ?? 1) === deps.supportedScheme
  )
  return compatible.length > 0 ? Math.max(...compatible.map((db) => db.version)) : null
}

export async function fetchConfigUncached(
  deps: DatabaseLocatorDeps,
  configUrl: string
): Promise<RemoteAppConfig> {
  return deps.filesStorage.getJson<RemoteAppConfig>(configUrl)
}

/**
 * Scans the local database directory for an existing lectorium DB file.
 * Works offline — no network required. Returns the storage path
 * (e.g. "lectorium/databases/lectorium.20260411211018.db") or null.
 * Paths in `incompatibleDbPaths` are excluded so a stale DB whose scheme
 * has already been rejected this session isn't picked again.
 *
 * Web (IDB) adapter returns an empty list, so this naturally resolves to
 * null on web and the caller falls back to a CDN download.
 */
export async function findLocalDatabase(
  deps: DatabaseLocatorDeps,
  incompatibleDbPaths: ReadonlySet<string>
): Promise<string | null> {
  const dir = deps.config.localPathTemplate.replace("/{version}.db", "")
  // dir = "lectorium/databases/lectorium" → parent = "lectorium/databases"
  const parentDir = dir.substring(0, dir.lastIndexOf("/"))

  const files = await deps.databaseFetcher.list(parentDir)
  const dbPath = files
    .filter((path) => {
      const name = path.substring(path.lastIndexOf("/") + 1)
      return name.startsWith("lectorium.") && name.endsWith(".db")
    })
    .filter((path) => !incompatibleDbPaths.has(path))
    .sort()
    .pop() // latest by version (lexicographic sort on timestamp-based names)

  return dbPath ?? null
}
