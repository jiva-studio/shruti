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
 *  - URL → `DownloadDestination` mapping keyed by `URL.pathname`, the same
 *    layout `useCapacitorRemoteFilesStorage` (transcripts) and
 *    `useWebRemoteFilesStorage` (`caches.open("<cacheDir>")`) use.
 *
 *    Downloaded track audio is the user's explicit "save for offline" set,
 *    so it MUST live in durable app storage (`directory: "data"` → Android
 *    `filesDir`, iOS `NSDocumentDirectory`). Writing it to `directory:
 *    "cache"` (the previous behaviour) put finished lecture audio in
 *    `Context.cacheDir` / `NSCachesDirectory`, which the OS is free to
 *    reclaim under storage pressure WITHOUT an uninstall — the user-
 *    reported "downloaded lectures disappear" bug (#51). Both the native
 *    files-storage reader and the web fallback resolve `data` to the same
 *    durable location, so cross-readability with the transcript cache is
 *    preserved.
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
    return { directory: "data", subdir, filename }
  }

  function idFor(url: string): string {
    return new URL(url).pathname
  }

  return {
    async download(url: string, onProgress?: ProgressCallback): Promise<string> {
      const id = idFor(url)
      const destination = destinationFor(url)

      const handles: PluginListenerHandle[] = []
      let onCompleted!: (localUrl: string) => void
      let onFailed!: (error: Error) => void
      const result = new Promise<string>((resolve, reject) => {
        onCompleted = resolve
        onFailed = reject
      })

      // Attach listeners BEFORE calling download(). A fast / already-cached
      // completion can fire its `completed`/`failed` event synchronously, so
      // if we awaited download() before the listener was registered the
      // promise would hang forever.
      if (onProgress) {
        handles.push(
          await MediaDownloader.addListener("progress", (e) => {
            if (e.id !== id) return
            onProgress(e.bytesDownloaded, e.contentLength, true)
          })
        )
      }
      handles.push(
        await MediaDownloader.addListener("completed", (e) => {
          if (e.id !== id) return
          if (onProgress) onProgress(e.bytesDownloaded, e.bytesDownloaded, false)
          onCompleted(e.localUrl)
        })
      )
      handles.push(
        await MediaDownloader.addListener("failed", (e) => {
          if (e.id !== id) return
          onFailed(new Error(e.error || "Download failed"))
        })
      )

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
