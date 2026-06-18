import { ref, watch, onUnmounted, inject, type Ref } from "vue"
import { ASSET_FAILOVER_KEY, FILES_STORAGE_KEY } from "./filesStorageKey.js"

export interface UseCachedImageUrlReturn {
  /** Locally-cached src for `<img>`, or undefined until the first resolve. */
  readonly src: Ref<string | undefined>
  /**
   * Signal that the current `src` failed to render (the `<img>` fired `error`).
   * Re-attempts the cached resolve a couple times with a short backoff before
   * giving up, so a cover that lost a flaky request can still recover instead
   * of staying invisible forever. No-op once attempts are exhausted.
   */
  retry(): void
}

/** Max load attempts (initial + retries) before giving up gracefully. */
const MAX_ATTEMPTS = 3
/** Base backoff between attempts; grows linearly per attempt. */
const RETRY_BACKOFF_MS = 250

/**
 * Resolve a remote image URL to a locally-cached one via the injected
 * `IRemoteFilesStorage` (provided by the composition root). The file bytes are
 * cached (CacheStorage on web, Filesystem on native); note that on web `get()`
 * mints a fresh `blob:` object URL on every call (even a cache hit), which is
 * why we revoke the previous one.
 *
 * `src` starts `undefined` (caller shows its placeholder), becomes the cached
 * URL on success, and falls back to the raw remote URL when caching is
 * unavailable or fails. A generation token guards against a slow earlier
 * resolve landing after a newer url change; any `blob:` URL is revoked on
 * url-change / unmount.
 */
export function useCachedImageUrl(remote: Ref<string | undefined>): UseCachedImageUrlReturn {
  const filesStorage = inject(FILES_STORAGE_KEY, null)
  // Last-resort CDN region failover (see ASSET_FAILOVER_KEY). Optional — tests
  // and the no-cache path run without it.
  const assetFailover = inject(ASSET_FAILOVER_KEY, null)
  const src = ref<string | undefined>(undefined)
  let objectUrl: string | undefined
  let token = 0
  // Attempts already spent on the current url (reset on every url change).
  let attempts = 0
  // Whether the one-shot region failover has run for the current url.
  let failoverTried = false

  function revoke(): void {
    if (objectUrl?.startsWith("blob:")) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }

  function delay(ms: number, current: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms)
      // Cancel the wait if a newer url change superseded this generation, so a
      // pending backoff can't resurrect a stale resolve.
      if (current !== token) clearTimeout(id)
    })
  }

  async function load(url: string | undefined): Promise<void> {
    const current = ++token
    revoke()
    src.value = undefined
    attempts = 0
    failoverTried = false
    if (!url) return
    if (!filesStorage) {
      // No cache wired (e.g. tests) — load the remote URL directly.
      src.value = url
      return
    }
    await attempt(url, current)
  }

  // One cached-resolve attempt for `url` under generation `current`. On
  // success commits the cached URL; on rejection retries the cached resolve a
  // couple times with a short linear backoff, then falls back to the raw
  // remote URL so the happy path and a recovered-but-still-failing link both
  // degrade gracefully. Bounded by MAX_ATTEMPTS and guarded by `token`.
  async function attempt(url: string, current: number): Promise<void> {
    if (current !== token || !filesStorage) return
    attempts++
    try {
      const local = await filesStorage.get(url)
      if (current !== token) {
        if (local.startsWith("blob:")) URL.revokeObjectURL(local)
        return
      }
      objectUrl = local
      src.value = local
    } catch {
      if (current !== token) return
      if (attempts < MAX_ATTEMPTS) {
        await delay(RETRY_BACKOFF_MS * attempts, current)
        await attempt(url, current)
        return
      }
      // Out of cached-resolve attempts — fall back to the raw remote URL.
      if (current === token) src.value = url
    }
  }

  // Called by the consumer when the rendered `<img>` fires `error` (e.g. the
  // raw-URL fallback also failed on a flaky link). Re-drives the cached resolve
  // if we still have attempts left; otherwise gives up quietly.
  function retry(): void {
    const url = remote.value
    if (!url) return
    // Same-region retry while we still have attempts left.
    if (filesStorage && attempts < MAX_ATTEMPTS) {
      const current = token
      void (async () => {
        await delay(RETRY_BACKOFF_MS * attempts, current)
        await attempt(url, current)
      })()
      return
    }
    // Exhausted same-region attempts AND the raw-url fallback failed too — the
    // active CDN region looks unreachable for this asset. Last resort: ask the
    // injected failover to serve it from another region (and promote that
    // region so streaming / other covers follow). One-shot per url.
    if (assetFailover && !failoverTried) {
      failoverTried = true
      const current = token
      void (async () => {
        const local = await assetFailover(url).catch(() => null)
        if (local && current === token) {
          revoke()
          objectUrl = local
          src.value = local
        }
      })()
    }
  }

  watch(remote, (u) => void load(u), { immediate: true })
  onUnmounted(revoke)

  return { src, retry }
}
