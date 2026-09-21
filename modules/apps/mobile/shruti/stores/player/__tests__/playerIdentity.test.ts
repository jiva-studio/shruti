import { describe, expect, it } from "vitest"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"
import { pickDurationMs, pickTrackLabels } from "../playerIdentity.js"

const PLAN = { title: "Plan title", authorName: "Plan author" }

function queueItem(title: string, author: string): AudioQueueItem {
  return { itemId: "i-1", url: "file:///a.mp3", title, author }
}

describe("pickTrackLabels", () => {
  it("prefers the queue metadata the lock screen already shows", () => {
    expect(pickTrackLabels(queueItem("Queue title", "Queue author"), PLAN)).toEqual({
      title: "Queue title",
      authorName: "Queue author",
    })
  })

  it("falls through an empty author to the play plan", () => {
    // The queue carries "" for a track with no resolvable author; taking it
    // would blank the player's author line.
    expect(pickTrackLabels(queueItem("Queue title", ""), PLAN)).toEqual({
      title: "Queue title",
      authorName: "Plan author",
    })
  })

  it("uses the play plan when the item is not in the queue", () => {
    expect(pickTrackLabels(undefined, PLAN)).toEqual({
      title: "Plan title",
      authorName: "Plan author",
    })
  })
})

describe("pickDurationMs", () => {
  it("prefers the duration the engine reported", () => {
    expect(pickDurationMs(1_400_000, 1_467_000)).toBe(1_400_000)
  })

  it("falls back to the play plan when the engine reports nothing", () => {
    expect(pickDurationMs(0, 1_467_000)).toBe(1_467_000)
    expect(pickDurationMs(0, null)).toBe(0)
    expect(pickDurationMs(0, undefined)).toBe(0)
  })
})
