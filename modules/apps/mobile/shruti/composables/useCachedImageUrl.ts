import { ref, watch, onUnmounted, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

export interface UseCachedImageUrlReturn {
  /** Locally-cached src for `<img>`, or undefined until the first resolve. */
  readonly src: Ref<string | undefined>
}

/**
 * Resolve a remote image URL to a locally-cached one via the shared
 * `IRemoteFilesStorage`. The file bytes are cached (CacheStorage on web,
 * Filesystem on native) so they're fetched from S3 once; note that on web
 * `get()` mints a fresh `blob:` object URL on every call (even a cache hit),
 * which is why we revoke the previous one.
 *
 * `src` starts `undefined` (caller shows its placeholder), becomes the cached
 * URL on success, and falls back to the raw remote URL if caching fails so the
 * image still appears. A generation token guards against a slow earlier
 * resolve landing after a newer url change; any `blob:` URL is revoked on
 * url-change / unmount to avoid leaks.
 */
export function useCachedImageUrl(remote: Ref<string | undefined>): UseCachedImageUrlReturn {
  const { filesStorage } = useShruti()
  const src = ref<string | undefined>(undefined)
  let objectUrl: string | undefined
  let token = 0

  function revoke(): void {
    if (objectUrl?.startsWith("blob:")) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }

  async function load(url: string | undefined): Promise<void> {
    const current = ++token
    revoke()
    src.value = undefined
    if (!url) return
    try {
      const local = await filesStorage.get(url)
      if (current !== token) {
        // A newer url arrived while we were fetching — drop this result.
        if (local.startsWith("blob:")) URL.revokeObjectURL(local)
        return
      }
      objectUrl = local
      src.value = local
    } catch {
      // Caching failed (offline first-load, transient 5xx). Show the remote
      // URL directly rather than a broken/placeholder tile.
      if (current === token) src.value = url
    }
  }

  watch(remote, (u) => void load(u), { immediate: true })
  onUnmounted(revoke)

  return { src }
}
