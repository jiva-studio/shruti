import type { DownloadFailureCause } from "@usecases/downloads/downloadPorts.js"

/**
 * The i18n key for a failed download.
 *
 * "Download failed. Check your internet connection and try again." is kept
 * for exactly the causes it describes — not `persist-failed`, where the bytes
 * arrived and the database write failed, nor `no-candidates` /
 * `already-in-progress`, which are not network conditions at all.
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
