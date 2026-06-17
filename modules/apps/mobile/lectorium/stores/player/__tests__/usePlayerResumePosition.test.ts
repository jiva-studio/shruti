import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { COMPLETION_THRESHOLD_MS } from "@lib/domain/listeningSession.js"
import { usePlayerResumePosition } from "../usePlayerResumePosition.js"

// High-water mark the fake repo returns, in SECONDS (the SQL adapter unit).
let hwmSec: number | null = 0

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      listeningSessions: {
        getResumePositionForItem: vi.fn(async () => hwmSec),
      },
    }),
  }),
}))

const ITEM = "pi-1" as PlaylistItemId

describe("usePlayerResumePosition.resolve", () => {
  beforeEach(() => {
    hwmSec = 0
  })

  it("resets to 0 when replaying a completed track (high-water mark at the end)", async () => {
    // The track was finished: the stored high-water mark sits at (or within
    // the completion threshold of) the duration. Resolving the resume position
    // must restart from 0 so re-opening a finished lecture doesn't drop the
    // user back at the credits — this is the assertion that was only described
    // in prose at the caller before.
    const durationMs = 1_467_000
    hwmSec = durationMs / 1000 // exactly at the end
    const { resolve } = usePlayerResumePosition()
    expect(await resolve({ itemId: ITEM }, durationMs)).toBe(0)

    // Also within the completion threshold (engine settle short of the end).
    hwmSec = (durationMs - (COMPLETION_THRESHOLD_MS - 500)) / 1000
    expect(await resolve({ itemId: ITEM }, durationMs)).toBe(0)
  })

  it("returns the saved position (in ms) for an in-progress track", async () => {
    const durationMs = 1_467_000
    hwmSec = 600 // 10 min in, far from the end
    const { resolve } = usePlayerResumePosition()
    expect(await resolve({ itemId: ITEM }, durationMs)).toBe(600_000)
  })

  it("returns 0 when the item has no sessions (null high-water mark)", async () => {
    hwmSec = null
    const { resolve } = usePlayerResumePosition()
    expect(await resolve({ itemId: ITEM }, 1_467_000)).toBe(0)
  })

  it("honours an explicit resumeFromMs over the saved position", async () => {
    hwmSec = 600
    const { resolve } = usePlayerResumePosition()
    expect(await resolve({ itemId: ITEM, resumeFromMs: 12_345 }, 1_467_000)).toBe(12_345)
    // resumeFromMs === null forces start-from-0 regardless of saved progress.
    expect(await resolve({ itemId: ITEM, resumeFromMs: null }, 1_467_000)).toBe(0)
  })
})
