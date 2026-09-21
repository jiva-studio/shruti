import { describe, expect, it } from "vitest"
import { smartLibraryChipCounts } from "../smartLibraryChips.js"

describe("smartLibraryChipCounts", () => {
  it("has nothing to show without filters", () => {
    expect(smartLibraryChipCounts(undefined)).toEqual([])
  })

  it("skips a dimension that is empty or absent", () => {
    expect(smartLibraryChipCounts({ authorIds: [], tagIds: ["t1"] })).toEqual([
      { key: "chat.actionConfigureSmartLibraryChipTopics", n: 1 },
    ])
  })

  it("keeps the card's dimension order", () => {
    const chips = smartLibraryChipCounts({
      languageCodes: ["ru"],
      authorIds: ["a1", "a2"],
      sourceIds: ["s1"],
    })
    expect(chips.map((c) => c.n)).toEqual([2, 1, 1])
  })
})
