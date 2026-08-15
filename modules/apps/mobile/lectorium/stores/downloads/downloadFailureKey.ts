import type { DownloadMediaError } from "@usecases/downloads/downloadMedia.js"

/**
 * Why a download did not happen, as far as the user is concerned.
 *
 * `connectivity` is the two callers that genuinely know it: the offline guard
 * (airplane mode) and the stall watch abandoning a transfer that stopped
 * moving. The rest come straight off `downloadMedia`'s `Result`, minus
 * `cancelled` — a user decision the store handles before it ever gets here.
 * `unknown` is the catch-all throw.
 */
export type DownloadFailureCause =
  | "connectivity"
  | Exclude<DownloadMediaError, "cancelled">
  | "unknown"

/**
 * The i18n key for a failed download.
 *
 * Every outcome but `cancelled` used to toast "Download failed. Check your
 * internet connection and try again." — including `persist-failed`, where the
 * bytes arrived and the DATABASE WRITE failed, and `no-candidates` /
 * `already-in-progress`, which are not network conditions at all (#1846).
 * That copy is kept for exactly the causes it describes.
 */
export function downloadFailureKey(cause: DownloadFailureCause): string {
  switch (cause) {
    // The bytes never made it. Connectivity is the honest first suspect, and
    // in `ru` this string carries the VPN hint.
    case "connectivity":
    case "transfer-failed":
      return "errors.downloadFailed"
    // Downloaded, then lost on the way to disk: a locked database, a full
    // disk, schema drift. Telling this user to check their connection sends
    // them to fix the one thing that worked.
    case "persist-failed":
      return "errors.downloadNotSaved"
    case "no-candidates":
      return "errors.downloadNoSource"
    case "already-in-progress":
      return "errors.downloadAlreadyRunning"
    case "unknown":
      return "errors.downloadFailedUnknown"
  }
}
