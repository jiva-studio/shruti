import type { TrackId } from "@lib/domain/core.js"
import { runDownloadAttempt, type DownloadAttemptDeps } from "./downloadAttempt.js"
import type { DownloadOrigin } from "./downloadNotices.js"
import { createInFlightTransfers } from "./inFlightTransfers.js"

export type DownloadRunnerDeps = Omit<
  DownloadAttemptDeps,
  "spendBudgetException" | "dropBudgetException" | "downloadAnyway"
>

export interface DownloadRunner {
  /**
   * Ensure the track's audio is cached locally and answer with the local URL
   * (`blob:` on web, `file://` on native), or `null` when it is not there to
   * give. Concurrent callers for one track share a single attempt.
   *
   * `path` is the storage key, not a URL: the attempt builds a fresh URL per
   * try, so a CDN swap mid-flight cannot leave a caller holding a stale one.
   * `filesize` is the catalog's byte size and funds the storage budget; without
   * it the budget falls back to a corpus average, which is a worse estimate but
   * never a free pass.
   */
  ensureDownloaded(
    trackId: TrackId,
    path: string,
    filesize?: number | null,
    origin?: DownloadOrigin
  ): Promise<string | null>
  isInFlight(trackId: TrackId): boolean
  cancelInFlight(trackId: TrackId): void
  reset(): void
}

/**
 * Runs download attempts: one at a time per track, each registered so a remove,
 * an archive or a wipe can reach it.
 */
export function createDownloadRunner(deps: DownloadRunnerDeps): DownloadRunner {
  const { app, rows } = deps
  const transfers = createInFlightTransfers({
    cancelTransfer: (url) => void app.mediaDownloader.cancel(url).catch(() => {}),
  })
  // One-off permissions to overshoot the budget, granted only by pressing
  // "Download anyway". Each is consumed by the very next budget decision for
  // that track and dropped when the attempt it was granted for settles, so it
  // cannot widen into a general bypass: nothing outside this store can add to
  // the set, and the configured limit is never written.
  const budgetExceptions = new Set<TrackId>()

  const attemptDeps: DownloadAttemptDeps = {
    ...deps,
    spendBudgetException: (trackId) => budgetExceptions.delete(trackId),
    dropBudgetException: (trackId) => budgetExceptions.delete(trackId),
    downloadAnyway: (trackId, path, filesize) => {
      // The refused attempt may still be settling. A fresh one must not join
      // it, and the grant must outlive its `finally`, which drops any grant it
      // did not spend — so both wait for it to let go of the track.
      // `running`, not `join`: joining would raise that transfer's origin to
      // "user", and the one still holding the track may be an unrelated queue
      // job whose failure notice would then lose its rate limit.
      const refused = transfers.running(trackId)
      void Promise.resolve(refused).then(() => {
        budgetExceptions.add(trackId)
        return ensureDownloaded(trackId, path, filesize, "user")
      })
    },
  }

  function ensureDownloaded(
    trackId: TrackId,
    path: string,
    filesize?: number | null,
    origin: DownloadOrigin = "user"
  ): Promise<string | null> {
    const joined = transfers.join(trackId, origin)
    if (joined) return joined
    // Read through any `pending` claim an outer caller already placed on the
    // row: the raw state would read "pending" and skip the whole retry path.
    const isRetryAfterFailure = rows.effectiveState(trackId) === "failed"
    // Answer the tap before the first await. The probe, the budget measurement
    // and the transfer can take anything from a frame to minutes, and without
    // this claim the row sits motionless the whole time.
    rows.markPending(trackId)
    const transfer = transfers.start(trackId, origin)
    const task = runDownloadAttempt(
      { trackId, path, filesize, isRetryAfterFailure, transfer },
      attemptDeps
    )
    transfers.adopt(transfer, task)
    return task
  }

  return {
    ensureDownloaded,
    isInFlight: transfers.has,
    cancelInFlight: transfers.cancel,
    reset: () => {
      transfers.abortAll()
      budgetExceptions.clear()
    },
  }
}
