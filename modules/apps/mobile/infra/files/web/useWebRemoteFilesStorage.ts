import type { IRemoteFilesStorage } from "@ports/app/index.js"

function urlToCacheKey(url: string): string {
  return new URL(url).pathname
}

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
    async getJson<T = unknown>(url: string): Promise<T> {
      const cache = await caches.open(cacheName)
      const cacheKey = urlToCacheKey(url)
      const cached = await cache.match(cacheKey)
      if (cached) return (await cached.json()) as T
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Remote file fetch failed: ${response.status} ${response.statusText} (${url})`
        )
      }
      await cache.put(cacheKey, response.clone())
      return (await response.json()) as T
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
