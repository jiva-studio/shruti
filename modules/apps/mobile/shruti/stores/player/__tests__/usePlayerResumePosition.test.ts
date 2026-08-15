import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { COMPLETION_THRESHOLD_MS } from "@lib/domain/listeningSession.js"
import { usePlayerResumePosition } from "../usePlayerResumePosition.js"

// High-water mark the fake repo returns, in SECONDS (the SQL adapter unit).
let hwmSec: number | null = 0

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
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

  it("keeps an explicit position that lands inside the completion threshold", async () => {
    // The chat outline card's chapter rows name a position, and a very short
    // final chapter (or a catalog duration that understates the file) starts
    // within COMPLETION_THRESHOLD_MS of the end. The clamp exists so a
    // REMEMBERED position doesn't drop the user back at the credits; applying
    // it to an instruction restarted the whole lecture from zero instead of
    // seeking to the chapter (#1856).
    const durationMs = 1_467_000
    const { resolve } = usePlayerResumePosition()
    const startMs = durationMs - (COMPLETION_THRESHOLD_MS - 500)
    expect(await resolve({ itemId: ITEM, resumeFromMs: startMs }, durationMs)).toBe(startMs)
    // Even at (and past) the very end — the caller, not the clamp, decides.
    expect(await resolve({ itemId: ITEM, resumeFromMs: durationMs }, durationMs)).toBe(durationMs)
    // …while the looked-up position on the same duration still resets.
    hwmSec = startMs / 1000
    expect(await resolve({ itemId: ITEM }, durationMs)).toBe(0)
  })

  it("still refuses a non-finite explicit position", async () => {
    const { resolve } = usePlayerResumePosition()
    expect(await resolve({ itemId: ITEM, resumeFromMs: Number.NaN }, 1_467_000)).toBe(0)
    expect(await resolve({ itemId: ITEM, resumeFromMs: -5_000 }, 1_467_000)).toBe(0)
  })
})
