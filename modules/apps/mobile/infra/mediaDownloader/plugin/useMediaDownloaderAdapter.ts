import type { PluginListenerHandle } from "@capacitor/core"
import { MediaDownloader, type DownloadDestination } from "@shruti/plugin-media-downloader"
import type { IMediaDownloader, ProgressCallback } from "@ports/app/index.js"

/**
 * `IMediaDownloader` over the `@shruti/plugin-media-downloader` plugin.
 *
 * The plugin's native implementations (Android WorkManager, iOS
 * URLSession.background, Web Cache API) are uniformly addressed via this
 * single adapter — `isNative` branching disappears from `main.ts`, since
 * Capacitor's `registerPlugin` selects the right backend at runtime.
 *
 * Contracts handled here:
 *  - URL → `DownloadDestination` mapping. We mirror the path convention
 *    used by `useCapacitorRemoteFilesStorage` (`Directory.Cache + "<cacheDir>/" + URL.pathname`)
 *    and `useWebRemoteFilesStorage` (`caches.open("<cacheDir>")` keyed by `URL.pathname`).
 *    Without this alignment, `IRemoteFilesStorage.has()/get()` wouldn't
 *    find files written by the plugin.
 *  - Per-call event subscription with cleanup, so multiple concurrent
 *    downloads don't leak listeners.
 *  - Mapping the plugin's `(bytes, total)` events to the legacy
 *    `ProgressCallback(received, total, isDownloading)` shape.
 */
export function useMediaDownloaderAdapter({ cacheDir }: { cacheDir: string }): IMediaDownloader {
  function destinationFor(url: string): DownloadDestination {
    const path = new URL(url).pathname.replace(/^\//, "")
    const lastSlash = path.lastIndexOf("/")
    const subdir = lastSlash >= 0 ? `${cacheDir}/${path.substring(0, lastSlash)}` : cacheDir
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path
    return { directory: "cache", subdir, filename }
  }

  function idFor(url: string): string {
    return new URL(url).pathname
  }

  return {
    async download(url: string, onProgress?: ProgressCallback): Promise<string> {
      const id = idFor(url)
      const destination = destinationFor(url)

      const handles: PluginListenerHandle[] = []
      const result = new Promise<string>((resolve, reject) => {
        if (onProgress) {
          MediaDownloader.addListener("progress", (e) => {
            if (e.id !== id) return
            onProgress(e.bytesDownloaded, e.contentLength, true)
          }).then((h) => handles.push(h))
        }
        MediaDownloader.addListener("completed", (e) => {
          if (e.id !== id) return
          if (onProgress) onProgress(e.bytesDownloaded, e.bytesDownloaded, false)
          resolve(e.localUrl)
        }).then((h) => handles.push(h))
        MediaDownloader.addListener("failed", (e) => {
          if (e.id !== id) return
          reject(new Error(e.error || "Download failed"))
        }).then((h) => handles.push(h))
      })

      try {
        await MediaDownloader.download({
          id,
          url,
          destination,
        })
        return await result
      } finally {
        for (const h of handles) await h.remove()
      }
    },

    async delete(url: string): Promise<void> {
      await MediaDownloader.deleteFile({ url })
    },

    async resolveLocalUrl(url: string): Promise<string | null> {
      const { localUrl } = await MediaDownloader.resolveLocalUrl({ url })
      return localUrl
    },
  }
}
