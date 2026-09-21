import type { PluginListenerHandle } from "@capacitor/core"
import {
  MediaDownloader,
  type DownloadDestination,
  type TaskState,
} from "@lectorium/plugin-media-downloader"
import {
  DownloadCancelledError,
  type DownloadCancelReason,
  type IMediaDownloader,
  type ProgressCallback,
} from "@ports/app/index.js"

/**
 * `IMediaDownloader` over the `@lectorium/plugin-media-downloader` plugin.
 *
 * The plugin's native implementations (Android WorkManager, iOS
 * URLSession.background, Web Cache API) are all addressed through this one
 * adapter — Capacitor's `registerPlugin` picks the backend at runtime, so no
 * `isNative` branching is needed above.
 *
 * URLs map to a `DownloadDestination` keyed by `URL.pathname`, the same layout
 * the transcript storage adapters use. Downloaded audio is the user's explicit
 * "save for offline" set, so it goes to durable app storage (`directory:
 * "data"`) — the OS is free to reclaim `cache` under storage pressure without
 * an uninstall.
 *
 * Each call subscribes to plugin events and cleans up after itself, so
 * concurrent downloads do not leak listeners, and the plugin's
 * `(bytes, total)` events are mapped to the port's `ProgressCallback`.
 */
/** States a transfer cannot be cancelled out of, because it already ended. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled"])

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

  /**
   * Claim a native task id for one attempt, distinct from every attempt for
   * this file that is still live.
   *
   * `attemptIdFor` separates candidates by host, which holds only while the
   * regions differ — two can name the same host. A repeated id is precisely
   * how the native side is told "this is the same download": it cancels the
   * task holding that id and enqueues a fresh one, which collides with a
   * candidate already writing to the shared destination. Racing needs two ids,
   * so a collision takes a suffix rather than a sibling's place, keeping the
   * `<fileKey>#…` shape `cancel()` matches on.
   */
  function claimAttempt(
    fileKey: string,
    baseId: string
  ): { id: string; record: { reason: DownloadCancelReason } } {
    const forFile = attempts.get(fileKey) ?? new Map()
    let id = baseId
    for (let n = 2; forFile.has(id); n++) id = `${baseId}~${n}`
    const record: { reason: DownloadCancelReason } = { reason: "user" }
    forFile.set(id, record)
    attempts.set(fileKey, forFile)
    return { id, record }
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
      const destination = destinationFor(url)
      const { id, record: attempt } = claimAttempt(fileKey, attemptIdFor(url))

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
            fileKey,
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
      await MediaDownloader.deleteFile({ fileKey: fileKeyFor(url) })
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
          // Only what a cancel can still stop. The platform keeps a finished
          // download listed — that listing IS how a saved file is found again
          // — and cancelling one deletes the very file the user saved, which
          // is `delete()`'s decision to make, never this one's.
          if (TERMINAL_STATES.has(task.state)) continue
          if (task.id === fileKey || task.id.startsWith(`${fileKey}#`)) ids.add(task.id)
        }
      }
      for (const id of ids) await MediaDownloader.cancel({ id, deletePartial: true })
    },

    async resolveLocalUrl(url: string): Promise<string | null> {
      // By the file's own name, not by where it was fetched from: the active
      // CDN changes under us (a promotion, a probe, a hedge won elsewhere) and
      // the file does not move when it does.
      const { localUrl } = await MediaDownloader.resolveLocalUrl({ fileKey: fileKeyFor(url) })
      return localUrl
    },
  }
}
