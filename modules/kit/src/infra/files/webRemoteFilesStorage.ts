import { type IRemoteFilesStorage, urlToCacheKey } from "./remoteFilesStorage.js"

/**
 * {@link IRemoteFilesStorage} backed by the browser Cache Storage API.
 * Files are keyed by their pathname (see {@link urlToCacheKey}) inside a
 * named cache, so the same asset served from different CDN regions
 * shares one entry.
 */
export function useWebRemoteFilesStorage({
  cacheName,
}: {
  cacheName: string
}): IRemoteFilesStorage {
  return {
    async get(url: string): Promise<string> {
      const cache = await caches.open(cacheName)
      const cacheKey = urlToCacheKey(url)
      const cached = await cache.match(cacheKey)
      if (cached) {
        const blob = await cached.blob()
        return URL.createObjectURL(blob)
      }
      const response = await fetch(url)
      // Don't cache error responses — otherwise a transient 5xx gets
      // pinned and every subsequent `get()` serves the error body.
      if (!response.ok) {
        throw new Error(
          `Remote file fetch failed: ${response.status} ${response.statusText} (${url})`
        )
      }
      await cache.put(cacheKey, response.clone())
      const blob = await response.blob()
      return URL.createObjectURL(blob)
    },

    async getText(url: string, opts?: { validate?: (text: string) => void }): Promise<string> {
      // Stale-while-revalidate: serve the cached body now (fast
      // cold-start) and refresh in the background so the next session
      // sees new content. `cache: 'no-store'` keeps the browser's HTTP
      // cache out of the loop — staleness is governed solely by our
      // CacheStorage entry, not heuristic freshness rules.
      const cache = await caches.open(cacheName)
      const cacheKey = urlToCacheKey(url)
      const cached = await cache.match(cacheKey)
      if (cached) {
        void (async () => {
          try {
            const fresh = await fetch(url, { cache: "no-store" })
            if (!fresh.ok) return
            const text = await fresh.text()
            // Reject a 200 body that fails the caller's validator (e.g. a
            // captive-portal HTML page) before it poisons the cache.
            opts?.validate?.(text)
            await cache.put(cacheKey, new Response(text))
          } catch {
            // Offline / invalid — leave the cached body in place.
          }
        })()
        return await cached.text()
      }
      // First-ever fetch — we have to block.
      const response = await fetch(url, { cache: "no-store" })
      if (!response.ok) {
        throw new Error(
          `Remote file fetch failed: ${response.status} ${response.statusText} (${url})`
        )
      }
      const text = await response.text()
      opts?.validate?.(text)
      await cache.put(cacheKey, new Response(text))
      return text
    },

    async has(url: string): Promise<boolean> {
      const cache = await caches.open(cacheName)
      const response = await cache.match(urlToCacheKey(url))
      return response !== undefined
    },

    async delete(url: string): Promise<void> {
      const cache = await caches.open(cacheName)
      await cache.delete(urlToCacheKey(url))
    },

    async clearAll(): Promise<void> {
      await caches.delete(cacheName)
    },
  }
}
