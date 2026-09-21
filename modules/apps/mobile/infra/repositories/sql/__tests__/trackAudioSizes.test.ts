import { describe, expect, it } from "vitest"
import type { TrackAudioRow } from "@lib/persistence/main"
import { largestPlayableSizes } from "../trackAudioSizes.js"

function audioRow(over: Partial<TrackAudioRow> & { track_id: string }): TrackAudioRow {
  return {
    language: "ru",
    kind: "original",
    path: `${over.track_id}.mp3`,
    filesize: 100,
    duration: 1000,
    ...over,
  }
}

describe("largestPlayableSizes", () => {
  it("has nothing to report for no rows", () => {
    expect(largestPlayableSizes([]).size).toBe(0)
  })

  it("takes the size of the single audio a track has", () => {
    const sizes = largestPlayableSizes([audioRow({ track_id: "t1", filesize: 4242 })])
    expect(sizes.get("t1" as never)).toBe(4242)
  })

  it("prefers the denoised version over the original of the same language", () => {
    const sizes = largestPlayableSizes([
      audioRow({ track_id: "t1", kind: "original", filesize: 900 }),
      audioRow({ track_id: "t1", kind: "clean", filesize: 300 }),
    ])
    expect(sizes.get("t1" as never)).toBe(300)
  })

  it("keeps the largest language when a track has several", () => {
    const sizes = largestPlayableSizes([
      audioRow({ track_id: "t1", language: "ru", kind: "clean", filesize: 300 }),
      audioRow({ track_id: "t1", language: "en", kind: "clean", filesize: 700 }),
    ])
    expect(sizes.get("t1" as never)).toBe(700)
  })

  it("leaves out a track whose playable audio has no usable size", () => {
    const sizes = largestPlayableSizes([
      audioRow({ track_id: "t1", filesize: null }),
      audioRow({ track_id: "t2", filesize: 0 }),
    ])
    expect(sizes.size).toBe(0)
  })

  it("keeps tracks apart", () => {
    const sizes = largestPlayableSizes([
      audioRow({ track_id: "t1", filesize: 10 }),
      audioRow({ track_id: "t2", filesize: 20 }),
    ])
    expect([...sizes.entries()]).toEqual([
      ["t1", 10],
      ["t2", 20],
    ])
  })
})
