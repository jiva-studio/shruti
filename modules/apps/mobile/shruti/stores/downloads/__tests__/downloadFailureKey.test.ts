import { describe, expect, it } from "vitest"
import en from "@shruti/i18n/locales/en/errors.js"
import { downloadFailureKey, type DownloadFailureCause } from "../downloadFailureKey.js"

/**
 * Issue #1846: every non-`cancelled` outcome toasted "Download failed. Check
 * your internet connection and try again." — including `persist-failed`, where
 * the bytes arrived and the DATABASE WRITE failed, and `no-candidates` /
 * `already-in-progress`, which are not network conditions at all.
 */

const CAUSES: DownloadFailureCause[] = [
  "connectivity",
  "transfer-failed",
  "persist-failed",
  "no-candidates",
  "already-in-progress",
  "unknown",
]

describe("downloadFailureKey", () => {
  it("keeps the connectivity copy for the two causes that are connectivity", () => {
    // The offline guard and the stall-abandon caller, plus a transfer whose
    // bytes never arrived.
    expect(downloadFailureKey("connectivity")).toBe("errors.downloadFailed")
    expect(downloadFailureKey("transfer-failed")).toBe("errors.downloadFailed")
  })

  it("does not blame the connection for a download that arrived", () => {
    expect(downloadFailureKey("persist-failed")).toBe("errors.downloadNotSaved")
    expect(en.downloadNotSaved).not.toContain("connection")
  })

  it("gives the non-network outcomes their own sentence", () => {
    expect(downloadFailureKey("no-candidates")).toBe("errors.downloadNoSource")
    expect(downloadFailureKey("already-in-progress")).toBe("errors.downloadAlreadyRunning")
  })

  it("does not claim to know the cause of an unexpected throw", () => {
    expect(downloadFailureKey("unknown")).toBe("errors.downloadFailedUnknown")
    expect(en.downloadFailedUnknown).not.toContain("connection")
  })

  it.each(CAUSES)("resolves %s to a real English string", (cause) => {
    const leaf = downloadFailureKey(cause).replace(/^errors\./, "")
    expect(typeof (en as Record<string, unknown>)[leaf]).toBe("string")
  })
})
