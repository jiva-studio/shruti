import { describe, expect, it, beforeEach } from "vitest"
import { setActivePinia, createPinia } from "pinia"
import type { DiscoveryHit } from "@lib/contracts"
import { useWebTrackSheetStore } from "../useWebTrackSheetStore.js"

describe("useWebTrackSheetStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("starts closed with null hit", () => {
    const store = useWebTrackSheetStore()
    expect(store.hit).toBeNull()
    expect(store.isOpen).toBe(false)
  })

  it("opens with a discovery hit and closes on close()", () => {
    const store = useWebTrackSheetStore()
    const hit: DiscoveryHit = {
      item_id: 123,
      media_url: "https://www.youtube.com/watch?v=123",
      title: "Bhagavad Gita Discourse",
      author: "Srila Prabhupada",
      location: "Bombay",
      recorded_on: "1974-03-31",
      chunk: "A profound discussion on the nature of the self.",
      score: 1.0,
    }

    store.open(hit)
    expect(store.hit).toEqual(hit)
    expect(store.isOpen).toBe(true)

    store.close()
    expect(store.hit).toBeNull()
    expect(store.isOpen).toBe(false)
  })
})
