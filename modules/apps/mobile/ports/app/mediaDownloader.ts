import type { ProgressCallback } from "./persistence.js"

/**
 * Why a transfer was ended locally instead of failing on its own.
 *
 * `"user"` — the person asked for it: remove/archive mid-download, a data
 * wipe, or the platform aborting the task. The whole download is over; the
 * caller must stop, not look for another server.
 *
 * `"superseded"` — the download itself dropped this attempt because a
 * competing one already won (`downloadMedia` hedges the connection phase
 * across CDN candidates and cancels the losers at the winner's first byte).
 * It is neither a failure nor a user decision: nobody is owed a message and
 * the candidate walk must not advance because of it.
 *
 * Keeping these two apart is the whole point of the type. They arrive on the
 * same native event (`failed` with `code: "cancelled"`), so nothing
 * downstream can tell them apart by inspection — the side that asked for the
 * cancellation is the only one that knows.
 */
export type DownloadCancelReason = "user" | "superseded"

/**
 * Thrown by `IMediaDownloader.download` when the transfer was ended by a
 * local decision rather than failing on its own. It is normal control flow,
 * not a fault: callers must settle quietly instead of painting a failed row
 * with a retry affordance — and must not retry it against another server,
 * since nothing was lost in transit.
 *
 * `reason` says which local decision it was; see `DownloadCancelReason`.
 *
 * Layer-pure use cases can't import this port, so they recognise it by
 * `name` and read `reason` structurally (see `downloadMedia`); keep the two
 * in sync.
 */
export class DownloadCancelledError extends Error {
  readonly reason: DownloadCancelReason

  constructor(reason: DownloadCancelReason = "user", message = "Download cancelled") {
    super(message)
    this.name = "DownloadCancelledError"
    this.reason = reason
  }
}

/**
 * Port for downloading and storing media files (track audio) for
 * offline playback.
 */
export interface IMediaDownloader {
  /**
   * Downloads a file from `url` into device storage and returns a local
   * URL the audio element can consume.
   *
   * Several `download()` calls for the SAME file may be in flight at once —
   * that is how `downloadMedia` hedges its CDN candidates. Each call is an
   * independent attempt addressed by its own url; they share one destination
   * on disk, and the implementation guarantees only one of them ever writes
   * to it.
   *
   * `signal` aborts THIS attempt and nothing else. It rejects with
   * `DownloadCancelledError` carrying `reason: "superseded"`, which is how a
   * losing candidate stays invisible to the user.
   */
  download(url: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<string>
  /** Deletes the local copy if present. */
  delete(url: string): Promise<void>
  /**
   * Aborts EVERY in-flight attempt for `url`'s file and removes any partial.
   * No-op if nothing is downloading for it. This is the user-initiated
   * cancel — the track was removed/archived, or the data was wiped — so the
   * attempts reject with `DownloadCancelledError` carrying `reason: "user"`
   * and the candidate walk stops for good.
   *
   * Host-independent: attempts are addressed by the url's path, so cancelling
   * with any region's url stops a transfer started against any other.
   */
  cancel(url: string): Promise<void>
  /** Returns the local URL for a cached file, or null if not cached. */
  resolveLocalUrl(url: string): Promise<string | null>
}
