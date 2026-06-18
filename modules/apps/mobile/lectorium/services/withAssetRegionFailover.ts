import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import type { IRemoteFilesStorage } from "@ports/app/index.js"

export interface AssetRegionFailoverDeps {
  /** Current region list (registry order). */
  readonly getRegions: () => readonly CdnServer[]
  /** The currently-active region (whose template the failing url was built with). */
  readonly getActiveServer: () => CdnServer
  /** Promote a region to active after it serves an asset the active one couldn't. */
  readonly promote: (id: string) => void
}

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
 * Wrap an {@link IRemoteFilesStorage} so a `get()` against a dead CDN region
 * fails over to the other regions: rebuild the same object key against each
 * other region, and on the first success promote it to active so every later
 * asset/streaming/transcript url (which all read the active region) follows —
 * not just this one cover.
 *
 * Only `get()` is wrapped; covers and other assets resolve through it. The
 * cache key is host-independent (pathname), so a file fetched from a fallback
 * region is served for the original region's url too. The other methods pass
 * through unchanged.
 *
 * Deps are injected (closures over the composition root) so the decorator is
 * pure + unit-testable and avoids a circular import on the root.
 */
export function withAssetRegionFailover(
  inner: IRemoteFilesStorage,
  deps: AssetRegionFailoverDeps
): IRemoteFilesStorage {
  return {
    ...inner,
    async get(url: string): Promise<string> {
      try {
        return await inner.get(url)
      } catch (firstError) {
        const active = deps.getActiveServer()
        const key = extractAssetKey(url, active.urlTemplate)
        if (key === null) throw firstError
        for (const region of deps.getRegions()) {
          if (region.id === active.id) continue
          try {
            const result = await inner.get(buildServerUrl(region, key))
            deps.promote(region.id)
            return result
          } catch {
            // Try the next region.
          }
        }
        // No region could serve it — surface the original failure so the
        // caller (e.g. CachedImage) runs its raw-url fallback / retry.
        throw firstError
      }
    },
  }
}
