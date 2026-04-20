import type { IMediaDownloader, ProgressCallback } from "@ports/app/index.js"

function urlToCacheKey(url: string): string {
  return new URL(url).pathname
}

/**
 * `IMediaDownloader` for the web build. Shares the `cacheName` with
 * `useWebRemoteFilesStorage` so a file downloaded here is readable by
 * the play-flow `IRemoteFilesStorage.has()` / `.get()`.
 *
 * Progress is reported by reading the response stream chunk-by-chunk
 * and measuring against `Content-Length`. When the server omits the
 * header (some CDNs), the total is reported as `-1` and the caller is
 * expected to render indeterminate progress.
 */
export function useWebMediaDownloader({
  cacheName,
}: {
  cacheName: string
}): IMediaDownloader {
  return {
    async download(url: string, onProgress?: ProgressCallback): Promise<string> {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Media download failed: ${response.status} ${response.statusText} (${url})`
        )
      }
      const total = Number(response.headers.get("Content-Length") ?? -1)

      if (!onProgress || !response.body) {
        const blob = await response.blob()
        const cache = await caches.open(cacheName)
        await cache.put(urlToCacheKey(url), new Response(blob))
        if (onProgress) onProgress(blob.size, blob.size, false)
        return URL.createObjectURL(blob)
      }

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress(received, total, true)
      }
      const blob = new Blob(chunks as BlobPart[])
      const cache = await caches.open(cacheName)
      await cache.put(urlToCacheKey(url), new Response(blob))
      onProgress(received, received, false)
      return URL.createObjectURL(blob)
    },

    async delete(url: string): Promise<void> {
      const cache = await caches.open(cacheName)
      await cache.delete(urlToCacheKey(url))
    },

    async resolveLocalUrl(url: string): Promise<string | null> {
      const cache = await caches.open(cacheName)
      const cached = await cache.match(urlToCacheKey(url))
      if (!cached) return null
      const blob = await cached.blob()
      return URL.createObjectURL(blob)
    },
  }
}
