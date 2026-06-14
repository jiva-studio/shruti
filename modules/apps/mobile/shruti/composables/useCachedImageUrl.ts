import { ref, watch, onUnmounted, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

export interface UseCachedImageUrlReturn {
  /** Locally-cached src for `<img>`, or undefined until the first resolve. */
  readonly src: Ref<string | undefined>
}

/**
 * Resolve a remote image URL to a locally-cached one via the shared
 * `IRemoteFilesStorage` ("fetch once, then serve from CacheStorage on web /
 * Filesystem on native"). Used for collection covers so they're downloaded
 * a single time and reused across sessions instead of re-fetched from S3 on
 * every render.
 *
 * `src` starts `undefined` (caller shows its placeholder), becomes the cached
 * URL on success, and falls back to the raw remote URL if caching fails so the
 * image still appears. Any `blob:` object URL it mints is revoked on
 * url-change / unmount to avoid leaks.
 */
export function useCachedImageUrl(remote: Ref<string | undefined>): UseCachedImageUrlReturn {
  const { filesStorage } = useShruti()
  const src = ref<string | undefined>(undefined)
  let objectUrl: string | undefined

  function revoke(): void {
    if (objectUrl?.startsWith("blob:")) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }

  async function load(url: string | undefined): Promise<void> {
    revoke()
    src.value = undefined
    if (!url) return
    try {
      const local = await filesStorage.get(url)
      objectUrl = local
      src.value = local
    } catch {
      // Caching failed (offline first-load, transient 5xx). Show the remote
      // URL directly rather than a broken/placeholder tile.
      src.value = url
    }
  }

  watch(remote, (u) => void load(u), { immediate: true })
  onUnmounted(revoke)

  return { src }
}
