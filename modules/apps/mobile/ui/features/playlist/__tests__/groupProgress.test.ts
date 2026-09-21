import { describe, expect, it } from "vitest"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import { groupProgressPct } from "../groupProgress.js"
import type { UiPlaybackProgress } from "../types.js"

function row(id: string, over: Partial<UiTrackRow> = {}): UiTrackRow {
  return {
    id,
    title: id,
    author: "",
    location: "",
    date: "",
    references: [],
    tags: [],
    state: "queued",
    progressPct: 0,
    disabled: false,
    dimmed: false,
    ...over,
  } as UiTrackRow
}

describe("groupProgressPct", () => {
  it("is 0 for an empty group", () => {
    expect(groupProgressPct([], undefined)).toBe(0)
  })

  it("averages what has been listened to", () => {
    const rows = [row("a", { listenedPct: 100 }), row("b", { listenedPct: 50 }), row("c")]
    expect(groupProgressPct(rows, undefined)).toBe(50)
  })

  it("scores a completed track as 100 even with no listening data", () => {
    expect(groupProgressPct([row("a", { state: "completed" })], undefined)).toBe(100)
  })

  it("holds the ring when a completed row goes back to downloading", () => {
    const rows = [
      row("a", { state: "pending", listenedPct: 100 }),
      row("b", { state: "completed", listenedPct: 100 }),
    ]
    expect(groupProgressPct(rows, undefined)).toBe(100)
  })

  it("takes the live position when it is ahead of the stored one", () => {
    const playback: UiPlaybackProgress = { trackId: "b", progressPct: 80 } as UiPlaybackProgress
    const rows = [row("a", { listenedPct: 100 }), row("b", { listenedPct: 20 })]
    expect(groupProgressPct(rows, playback)).toBe(90)
  })

  it("never lets a replay pull a completed track below the 100 it earned", () => {
    const playback: UiPlaybackProgress = { trackId: "a", progressPct: 5 } as UiPlaybackProgress
    expect(groupProgressPct([row("a", { listenedPct: 100 })], playback)).toBe(100)
  })
})
