import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"

export interface AssetFailoverDeps {
  /** Current region list (registry order). */
  readonly getRegions: () => readonly CdnServer[]
  /** The active region — whose template the failing url was built with. */
  readonly getActiveServer: () => CdnServer
  /** Promote a region to active after it serves an asset the active one couldn't. */
  readonly promote: (id: string) => void
  /** Fetch+cache an asset, resolving to a locally-usable url (files storage get). */
  readonly fetch: (url: string) => Promise<string>
}

/** A last-resort resolver: given a url that failed on the active region, return
 *  a locally-usable url served from another region, or null if none can. */
export type AssetFailover = (failedUrl: string) => Promise<string | null>

/**
 * Recover the S3 object key from a built asset url by stripping the active
 * region's `urlTemplate` around `{path}`. Returns `null` when the url wasn't
 * built from this template (can't fail over what we can't re-target).
 *
 * Exported for tests.
 */
export function extractAssetKey(url: string, urlTemplate: string): string | null {
  const [prefix, suffix = ""] = urlTemplate.split("{path}")
  if (!url.startsWith(prefix)) return null
  let key = url.slice(prefix.length)
  if (suffix) {
    if (!key.endsWith(suffix)) return null
    key = key.slice(0, key.length - suffix.length)
  }
  return key
}

/**
 * Build the asset region-failover resolver.
 *
 * Called as a LAST RESORT — only after the caller (CachedImage via
 * `useCachedImageUrl`) has exhausted its same-region retries AND the raw-url
 * fallback, i.e. the active region looks genuinely unreachable for this asset,
 * not just flaky. (Doing it inside every `get()` would fight that same-region
 * retry and flip the active CDN on a single transient blip.)
 *
 * It rebuilds the same object key against each OTHER region and, on the first
 * that serves it, promotes that region to active so streaming / transcripts /
 * other covers (all read the active region) follow the live CDN too. Returns
 * the locally-usable url, or null if no region could serve it.
 */
export function createAssetFailover(deps: AssetFailoverDeps): AssetFailover {
  return async (failedUrl: string): Promise<string | null> => {
    const active = deps.getActiveServer()
    const key = extractAssetKey(failedUrl, active.urlTemplate)
    if (key === null) return null
    for (const region of deps.getRegions()) {
      if (region.id === active.id) continue
      try {
        const local = await deps.fetch(buildServerUrl(region, key))
        deps.promote(region.id)
        return local
      } catch {
        // Try the next region.
      }
    }
    return null
  }
}
