import { describe, expect, it } from "vitest"
import { COMPLETION_THRESHOLD_MS } from "@lib/domain/listeningSession.js"
import {
  nextProgressMs,
  reachesCompletion,
  resolvePlaybackDurationMs,
} from "../playlistProgress.js"

describe("resolvePlaybackDurationMs", () => {
  it("takes the shorter of the catalog and engine durations", () => {
    // A re-encoded file is shorter than the catalog says; judging completion
    // against the catalog value would never let it complete.
    expect(resolvePlaybackDurationMs(1_500_000, 1_400_000)).toBe(1_400_000)
    expect(resolvePlaybackDurationMs(1_400_000, 1_500_000)).toBe(1_400_000)
  })

  it("falls back to whichever duration is known", () => {
    expect(resolvePlaybackDurationMs(0, 1_400_000)).toBe(1_400_000)
    expect(resolvePlaybackDurationMs(1_500_000, undefined)).toBe(1_500_000)
    expect(resolvePlaybackDurationMs(1_500_000, 0)).toBe(1_500_000)
  })

  it("is 0 when neither side knows a duration", () => {
    expect(resolvePlaybackDurationMs(0, undefined)).toBe(0)
    expect(resolvePlaybackDurationMs(-1, -1)).toBe(0)
  })
})

describe("nextProgressMs", () => {
  it("never rewinds a completed item", () => {
    // The engine settles a few hundred ms short of the reported duration; that
    // late tick must not drop the radial back below 100%.
    expect(nextProgressMs(1_467_000, 1_466_400, true)).toBe(1_467_000)
  })

  it("still advances a completed item", () => {
    expect(nextProgressMs(1_466_000, 1_467_000, true)).toBe(1_467_000)
  })

  it("takes the incoming position for an unfinished item", () => {
    expect(nextProgressMs(600_000, 12_000, false)).toBe(12_000)
  })
})

describe("reachesCompletion", () => {
  it("completes at and within the threshold of the end", () => {
    expect(reachesCompletion(1_467_000, 1_467_000)).toBe(true)
    expect(reachesCompletion(1_467_000 - (COMPLETION_THRESHOLD_MS - 1), 1_467_000)).toBe(true)
  })

  it("does not complete further from the end", () => {
    expect(reachesCompletion(1_467_000 - (COMPLETION_THRESHOLD_MS + 1), 1_467_000)).toBe(false)
  })

  it("never completes without a known duration", () => {
    expect(reachesCompletion(600_000, 0)).toBe(false)
  })
})
