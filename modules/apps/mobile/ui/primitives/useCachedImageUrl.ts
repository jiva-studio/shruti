import { ref, watch, onUnmounted, inject, type Ref } from "vue"
import { FILES_STORAGE_KEY } from "./filesStorageKey.js"

export interface UseCachedImageUrlReturn {
  /** Locally-cached src for `<img>`, or undefined until the first resolve. */
  readonly src: Ref<string | undefined>
}

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
    if (!filesStorage) {
      // No cache wired (e.g. tests) — load the remote URL directly.
      src.value = url
      return
    }
    try {
      const local = await filesStorage.get(url)
      if (current !== token) {
        if (local.startsWith("blob:")) URL.revokeObjectURL(local)
        return
      }
      objectUrl = local
      src.value = local
    } catch {
      if (current === token) src.value = url
    }
  }

  watch(remote, (u) => void load(u), { immediate: true })
  onUnmounted(revoke)

  return { src }
}
