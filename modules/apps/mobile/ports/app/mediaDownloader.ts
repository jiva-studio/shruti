import type { ProgressCallback } from "./persistence.js"

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
