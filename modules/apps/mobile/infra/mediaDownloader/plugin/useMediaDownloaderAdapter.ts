import type { PluginListenerHandle } from "@capacitor/core"
import { MediaDownloader, type DownloadDestination } from "@shruti/plugin-media-downloader"
import {
  DownloadCancelledError,
  type DownloadCancelReason,
  type IMediaDownloader,
  type ProgressCallback,
} from "@ports/app/index.js"

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

  /**
   * The file an attempt is for. Host-independent, so every CDN candidate for
   * one lecture shares it — that is what makes `cancel(url)`, `delete(url)`
   * and the on-disk destination work whichever region delivered the bytes.
   */
  function fileKeyFor(url: string): string {
    return new URL(url).pathname
  }

  /**
   * The native task id for ONE attempt. Candidates for the same file are now
   * in flight simultaneously (`downloadMedia` hedges them), and the native
   * plugins treat a repeated id as "same download" — a second candidate under
   * the shared file key would supersede the first instead of racing it. The
   * host disambiguates them; the destination deliberately does not, so all
   * candidates still write to the one local path.
   */
  function attemptIdFor(url: string): string {
    return `${fileKeyFor(url)}#${new URL(url).host}`
  }

  /**
   * Live attempts, per file. Holds the cancellation reason each attempt
   * should settle with: the abort signal marks its own attempt
   * `"superseded"`, `cancel(url)` marks every attempt for the file
   * `"user"`. Nothing downstream can tell the two apart — they arrive as the
   * same native event — so the side that asks records it here.
   */
  const attempts = new Map<string, Map<string, { reason: DownloadCancelReason }>>()

  function trackAttempt(fileKey: string, attemptId: string): { reason: DownloadCancelReason } {
    const record: { reason: DownloadCancelReason } = { reason: "user" }
    const forFile = attempts.get(fileKey) ?? new Map()
    forFile.set(attemptId, record)
    attempts.set(fileKey, forFile)
    return record
  }

  function untrackAttempt(fileKey: string, attemptId: string): void {
    const forFile = attempts.get(fileKey)
    if (!forFile) return
    forFile.delete(attemptId)
    if (forFile.size === 0) attempts.delete(fileKey)
  }

  return {
    async download(
      url: string,
      onProgress?: ProgressCallback,
      signal?: AbortSignal
    ): Promise<string> {
      const fileKey = fileKeyFor(url)
      const id = attemptIdFor(url)
      const destination = destinationFor(url)
      const attempt = trackAttempt(fileKey, id)

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
          // Every platform reports a locally-aborted transfer as `failed`
          // plus a code — that is what settles this promise when the user
          // removes/archives a track mid-transfer, and equally when the
          // hedge drops a losing candidate. Reject with the typed error so
          // callers can tell it from a genuine failure: neither deserves a
          // retry affordance, and neither may rotate to another CDN (the
          // bytes were dropped on purpose, not lost in transit). `reason`
          // carries which of the two it was — recorded by whoever asked.
          if (e.code === "cancelled") return onFailed(new DownloadCancelledError(attempt.reason))
          if (e.code === "removed") {
            return onFailed(
              new DownloadCancelledError("user", "Download was removed while in flight")
            )
          }
          onFailed(new Error(e.error || "Download failed"))
        })
      )

      // Abort THIS attempt only. `deletePartial: false` is load-bearing: the
      // candidates share one destination, and a loser must never unlink the
      // partial the winner is still writing. We settle the promise ourselves
      // rather than waiting for the native `cancelled` event — a cancel that
      // lands before the task is registered produces no event at all, and a
      // loser must not be able to hang the hedge.
      const onAbort = (): void => {
        attempt.reason = "superseded"
        void MediaDownloader.cancel({ id, deletePartial: false }).catch(() => {})
        onFailed(new DownloadCancelledError("superseded"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      try {
        if (signal?.aborted) {
          onAbort()
        } else {
          await MediaDownloader.download({
            id,
            url,
            destination,
          })
        }
        return await result
      } finally {
        signal?.removeEventListener("abort", onAbort)
        untrackAttempt(fileKey, id)
        for (const h of handles) await h.remove()
      }
    },

    async delete(url: string): Promise<void> {
      await MediaDownloader.deleteFile({ url })
    },

    /**
     * The user-initiated cancel: stop the whole download, not one attempt.
     * Every live candidate for this file is aborted and tagged `"user"`, so
     * `downloadMedia` ends its walk instead of rotating to the next region.
     * `deletePartial` drops the half-written file so it can't be mistaken
     * for a complete download later.
     */
    async cancel(url: string): Promise<void> {
      const fileKey = fileKeyFor(url)
      const live = attempts.get(fileKey)
      const ids = new Set<string>()
      if (live && live.size > 0) {
        for (const [attemptId, record] of live) {
          record.reason = "user"
          ids.add(attemptId)
        }
      } else {
        // Nothing in flight in THIS session — but a transfer that outlived a
        // process restart still is, natively, under an attempt id we never
        // saw. Ask the platform which tasks belong to this file instead of
        // guessing a host. (Ids written before hedging are the bare file key.)
        const { tasks } = await MediaDownloader.listTasks()
        for (const task of tasks) {
          if (task.id === fileKey || task.id.startsWith(`${fileKey}#`)) ids.add(task.id)
        }
      }
      for (const id of ids) await MediaDownloader.cancel({ id, deletePartial: true })
    },

    async resolveLocalUrl(url: string): Promise<string | null> {
      const { localUrl } = await MediaDownloader.resolveLocalUrl({ url })
      return localUrl
    },
  }
}
