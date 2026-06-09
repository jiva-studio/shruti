import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Flat, collision-free cache name derived from the asset URL's path. A
 * verse and a citation from different sources keep distinct keys, and the
 * slashes are flattened for the flat platform cache.
 */
function cacheFilenameFor(url: string): string {
  return new URL(url).pathname.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "_")
}

/**
 * Shared "download once, play from disk" resolver for the inline audio
 * excerpts — the verse recitation card and the chat citation chip use the
 * same flow so both get an offline-able, instant-replay local copy.
 *
 * Callers hand over only the remote URL (or a getter that resolves it);
 * the cache key is derived from that URL here, so the view layer never
 * deals with cache filenames. `excerptCache.toLocalUrl` (infra) turns the
 * cached `file://` URI into a URL the WebView `<audio>` element can load,
 * so the view layer never touches Capacitor either.
 */
export function useCachedExcerptUrl() {
  const { excerptCache } = useLectorium()

  async function resolve(remoteUrl: () => string | Promise<string>): Promise<string> {
    const url = await remoteUrl()
    const filename = cacheFilenameFor(url)
    const cached = await excerptCache.findLocal(filename)
    const fileUri = cached ?? (await excerptCache.download({ url, filename }))
    return excerptCache.toLocalUrl(fileUri)
  }

  return { resolve }
}
