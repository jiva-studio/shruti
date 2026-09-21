import { describe, expect, it } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import { createDownloadRows } from "../downloadRows.js"

const A = "track-a" as TrackId

describe("download rows", () => {
  it("drops the progress gauge with any state that is not a transfer", () => {
    const rows = createDownloadRows()
    rows.setState(A, "downloading")
    rows.setProgress(A, 42)

    rows.setState(A, "completed")

    expect(rows.getProgress(A)).toBe(0)
    expect(rows.progress.value.has(A)).toBe(false)
  })

  it("clamps a progress report to whole percentage points", () => {
    const rows = createDownloadRows()
    rows.setProgress(A, -5)
    expect(rows.getProgress(A)).toBe(0)
    rows.setProgress(A, 142.6)
    expect(rows.getProgress(A)).toBe(100)
  })
})

describe("pending claims", () => {
  it("shows a claimed row as pending while it still IS what it was", () => {
    const rows = createDownloadRows()
    rows.setState(A, "failed")

    rows.markPending(A)

    expect(rows.getState(A)).toBe("pending")
    expect(rows.getEffectiveState(A)).toBe("failed")
  })

  it("restores what the claim replaced when the last holder lets go", () => {
    const rows = createDownloadRows()
    rows.setState(A, "failed")
    rows.markPending(A)
    rows.markPending(A)

    rows.clearPending(A)
    expect(rows.getState(A)).toBe("pending")

    rows.clearPending(A)
    expect(rows.getState(A)).toBe("failed")
  })

  it("blanks a row that held nothing before the claim", () => {
    const rows = createDownloadRows()
    rows.markPending(A)
    rows.clearPending(A)

    expect(rows.states.value.has(A)).toBe(false)
  })

  it("leaves a real outcome recorded under the claim alone", () => {
    const rows = createDownloadRows()
    rows.markPending(A)
    rows.setState(A, "completed")

    rows.clearPending(A)

    expect(rows.getState(A)).toBe("completed")
  })

  it("does not rewind a finished or a running row to a shimmer", () => {
    const rows = createDownloadRows()
    rows.setState(A, "completed")
    rows.markPending(A)
    expect(rows.getState(A)).toBe("completed")

    rows.setState(A, "downloading")
    rows.markPending(A)
    expect(rows.getState(A)).toBe("downloading")
  })

  it("releases nothing when no claim was granted", () => {
    const rows = createDownloadRows()
    rows.setState(A, "completed")

    rows.clearPending(A)

    expect(rows.getState(A)).toBe("completed")
  })

  it("does not put a cancelled row's state back", () => {
    const rows = createDownloadRows()
    rows.setState(A, "failed")
    rows.markPending(A)

    rows.clearState(A)
    rows.clearPending(A)

    expect(rows.states.value.has(A)).toBe(false)
  })
})

describe("optimistic paints", () => {
  it("holds a terminal state against both optimistic paints", () => {
    const rows = createDownloadRows()
    rows.setState(A, "failed")
    rows.markStartingDownload(A)
    rows.markDeferred(A)
    expect(rows.getState(A)).toBe("failed")

    rows.setState(A, "completed")
    rows.markStartingDownload(A)
    rows.markDeferred(A)
    expect(rows.getState(A)).toBe("completed")
  })

  it("reads a terminal state through a claim, not the shimmer over it", () => {
    const rows = createDownloadRows()
    rows.setState(A, "completed")
    rows.setState(A, "deferred")
    rows.markPending(A)

    rows.markStartingDownload(A)

    expect(rows.getState(A)).toBe("downloading")
  })
})
