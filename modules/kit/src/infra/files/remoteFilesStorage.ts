/**
 * Port for a remote files cache. Implementations fetch a file from its
 * URL on first access, cache it under a platform-specific store (Cache
 * API on web, Filesystem on Capacitor), and return a local URL the UI
 * can put into `<img src>` / `<audio src>` attributes without
 * re-downloading on subsequent accesses.
 */
export interface IRemoteFilesStorage {
  /** Resolve to a locally-usable URL, fetching and caching on a miss. */
  get(url: string): Promise<string>
  /**
   * Like {@link get} but resolves to the raw text body, served
   * stale-while-revalidate: a cached body is returned immediately and a
   * background refresh updates the cache for the next read. Keeps platform
   * IO out of the caller (no caller-level `fetch(cachedUrl)`).
   *
   * Format-agnostic: parsing is the caller's concern (see
   * {@link createJsonRemoteStorage}). `opts.validate` is invoked on a freshly
   * fetched body BEFORE it's cached; throwing from it skips the write and
   * keeps the previous cached body — used to reject a captive-portal HTML
   * page that returns 200 but isn't the expected payload.
   */
  getText(url: string, opts?: { validate?: (text: string) => void }): Promise<string>
  /** True when `url` has a cached entry. */
  has(url: string): Promise<boolean>
  /** Remove a single cached entry. */
  delete(url: string): Promise<void>
  /** Remove every cached entry. */
  clearAll(): Promise<void>
}

/**
 * Stable cache key for a remote URL: its pathname. Two URLs that differ
 * only by host (e.g. the same asset served from different CDN regions)
 * map to the same key, so a file cached against one region is served for
 * the other. Pure — no IO — so cache-key behaviour is unit-testable.
 */
export function urlToCacheKey(url: string): string {
  return new URL(url).pathname
}
