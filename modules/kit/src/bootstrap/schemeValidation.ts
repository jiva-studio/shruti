/**
 * Generic content-DB scheme validation: open a resolved DB file, read the
 * scheme version it records, and confirm it matches what this build supports.
 * Scheme `0` is tolerated as a legacy/unknown fallback (apps that record no
 * scheme yield 0).
 *
 * Wrapped in a hard-capped retry loop so an incompatible CDN can't loop
 * forever: each mismatch drops the bad local file + (optionally) the cached
 * config, marks the path rejected, and re-resolves.
 */
import {
  resolveContentDatabase,
  NoCompatibleDatabaseError,
  type RemoteContentConfig,
  type ResolveContentDatabaseOptions,
  type ResolveResult,
} from "./contentDatabaseResolver.js"

/** A scheme is acceptable when it's the legacy `0` or an exact match. */
export function isSchemeCompatible(scheme: number, supportedScheme: number): boolean {
  return scheme === 0 || scheme === supportedScheme
}

export interface OpenAndValidateOptions<TConfig extends RemoteContentConfig, TDb> {
  /** Re-runs the offline-first resolve each attempt (sees the growing reject set). */
  buildResolveOptions: (
    incompatibleDbPaths: ReadonlySet<string>
  ) => ResolveContentDatabaseOptions<TConfig>
  supportedScheme: number
  /** Open the DB at `path`; returns the opened handle. */
  openDatabase: (path: string) => Promise<TDb>
  /** Close the currently-open DB (called between failed attempts). */
  closeDatabase: () => Promise<void>
  /** Read the scheme version of the open DB. */
  readSchemeVersion: () => Promise<number>
  /** Drop the known-bad local DB file so the next attempt re-fetches. */
  deleteLocalDatabase: (path: string) => Promise<void>
  /** Drop the cached remote config so the next attempt re-probes. Optional. */
  invalidateConfigCache?: () => Promise<void>
  /** Paths already known-bad before the first attempt (e.g. a cached DB the
   *  caller already opened + rejected). Seeds the internal reject set so the
   *  first re-scan skips them even if the underlying delete is a no-op. */
  seedRejectedPaths?: Iterable<string>
  /** Max scheme-mismatch retries before throwing. Default 3. */
  maxRetries?: number
}

export interface OpenAndValidateResult<TDb> {
  database: TDb
  result: ResolveResult
  scheme: number
}

/**
 * Resolve → open → validate the content DB, retrying on scheme mismatch.
 * Returns the opened, validated DB handle. Throws after `maxRetries`
 * mismatches with the observed schemes for diagnostics.
 */
export async function openAndValidateContentDatabase<TConfig extends RemoteContentConfig, TDb>(
  opts: OpenAndValidateOptions<TConfig, TDb>
): Promise<OpenAndValidateResult<TDb>> {
  const maxRetries = opts.maxRetries ?? 3
  const incompatibleDbPaths = new Set<string>(opts.seedRejectedPaths ?? [])
  const observedSchemes: number[] = []
  // The config can be served from a local cache. A stale cached config that
  // lists no compatible version makes resolve throw before we ever open a DB,
  // and every retry re-reads the same cached config → permanent failure even
  // after the CDN publishes a compatible one. So on that specific miss we drop
  // the cached config once and re-probe with a fresh one before giving up.
  let refreshedConfigForMiss = false

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let result: ResolveResult
    try {
      result = await resolveContentDatabase(opts.buildResolveOptions(incompatibleDbPaths))
    } catch (err) {
      if (err instanceof NoCompatibleDatabaseError && !refreshedConfigForMiss) {
        refreshedConfigForMiss = true
        await opts.invalidateConfigCache?.().catch(() => undefined)
        continue
      }
      throw err
    }
    // Opening / reading the scheme can throw if the file passed the cheap
    // header/size gate but is still structurally corrupt (valid magic, garbage
    // pages — e.g. an OS-killed mid-write download). Treat that exactly like a
    // scheme mismatch: drop the bad file, reject the path, and re-resolve —
    // instead of letting the throw escape and abort bootstrap permanently with
    // no self-heal.
    let database: TDb
    let scheme: number
    try {
      database = await opts.openDatabase(result.localPath)
      scheme = await opts.readSchemeVersion()
    } catch {
      await opts.closeDatabase().catch(() => undefined)
      incompatibleDbPaths.add(result.localPath)
      await opts.deleteLocalDatabase(result.localPath).catch(() => undefined)
      await opts.invalidateConfigCache?.().catch(() => undefined)
      continue
    }

    if (isSchemeCompatible(scheme, opts.supportedScheme)) {
      return { database, result, scheme }
    }

    observedSchemes.push(scheme)
    await opts.closeDatabase()
    incompatibleDbPaths.add(result.localPath)
    await opts.deleteLocalDatabase(result.localPath).catch(() => undefined)
    await opts.invalidateConfigCache?.().catch(() => undefined)
  }

  const observed = observedSchemes.join(", ") || "none"
  throw new Error(
    `Content database scheme validation failed after ${maxRetries} attempts. ` +
      `Expected scheme ${opts.supportedScheme}, got: ${observed}. ` +
      `The CDN likely hasn't published a compatible database yet.`
  )
}
