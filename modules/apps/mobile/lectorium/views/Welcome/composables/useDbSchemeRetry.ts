import {
  resolveContentDatabase,
  type ResolveContentDatabaseDeps,
} from "./resolveContentDatabase.js"

export interface UseDbSchemeRetryDeps {
  /** Wraps `lectorium.openContentDatabase` etc — same surface used by the
   *  resolve step. */
  buildLocatorDeps: () => ResolveContentDatabaseDeps
  supportedScheme: number
  openContentDatabase: (path: string) => Promise<unknown>
  closeContentDatabase: () => Promise<void>
  readContentSchemeVersion: () => Promise<number>
  /** Drop the known-bad local DB file so the next attempt re-fetches. */
  deleteLocalDb: (path: string) => Promise<void>
  /** Drop the cached config so the next attempt re-probes for a fresh
   *  manifest. */
  invalidateRemoteConfigCache: () => Promise<void>
  /** Default: 3. Counter-based (vs `Set.size > max`) so an incompatible
   *  CDN can't loop forever advertising the same version. */
  maxRetries?: number
}

/**
 * Wraps the resolve → open → validate loop with a hard retry cap. After
 * `maxRetries` mismatched scheme versions it throws a single error with
 * the observed schemes so an operator can diagnose CDN drift.
 */
export function useDbSchemeRetry(deps: UseDbSchemeRetryDeps): {
  resolveAndValidate: () => Promise<void>
} {
  const incompatibleDbPaths = new Set<string>()
  const maxRetries = deps.maxRetries ?? 3

  async function resolveAndValidate(): Promise<void> {
    const observedSchemes: number[] = []

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const dbPath = await resolveContentDatabase(deps.buildLocatorDeps(), incompatibleDbPaths)
      await deps.openContentDatabase(dbPath)
      const scheme = await deps.readContentSchemeVersion()

      if (scheme === 0 || scheme === deps.supportedScheme) return

      observedSchemes.push(scheme)
      await deps.closeContentDatabase()
      incompatibleDbPaths.add(dbPath)
      await deps.deleteLocalDb(dbPath).catch(() => undefined)
      await deps.invalidateRemoteConfigCache().catch(() => undefined)
    }

    const observed = observedSchemes.join(", ") || "none"
    throw new Error(
      `Content database scheme validation failed after ${maxRetries} attempts. ` +
        `Expected ${deps.supportedScheme}, got: ${observed}. ` +
        `The CDN likely hasn't published a compatible DB yet — publish a new ` +
        `lectorium.{version}.db via lectorium-mcp catalog.publish, or bump ` +
        `modules/db-scheme.json to match what's available.`
    )
  }

  return { resolveAndValidate }
}
