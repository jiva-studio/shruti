import type { ProgressCallback } from "./persistence.js"

/**
 * Thrown by `IMediaDownloader.download` when the transfer ended because it
 * was cancelled — `cancel()` from the app (the user removed/archived the
 * track, a data wipe) or the platform aborting the task — rather than
 * failing on its own. It is normal control flow, not a fault: callers must
 * settle quietly instead of painting a failed row with a retry affordance.
 *
 * Layer-pure use cases can't import this port, so they recognise it by
 * `name` (see `downloadMedia`); keep the two in sync.
 */
export class DownloadCancelledError extends Error {
  constructor(message = "Download cancelled") {
    super(message)
    this.name = "DownloadCancelledError"
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
   */
  download(url: string, onProgress?: ProgressCallback): Promise<string>
  /** Deletes the local copy if present. */
  delete(url: string): Promise<void>
  /**
   * Aborts an in-flight transfer for `url` and removes any partial file.
   * No-op if nothing is downloading for that url. Used when the user
   * removes/archives a track mid-download so we stop wasting bandwidth and
   * never leave an orphan partial behind.
   */
  cancel(url: string): Promise<void>
  /** Returns the local URL for a cached file, or null if not cached. */
  resolveLocalUrl(url: string): Promise<string | null>
}
