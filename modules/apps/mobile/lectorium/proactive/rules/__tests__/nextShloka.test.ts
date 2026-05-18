import { describe, expect, it } from "vitest"
import { computeNextTokens } from "../nextShloka.js"

describe("computeNextTokens", () => {
  it("increments the last numeric token by one", () => {
    expect(computeNextTokens(["2", "13"])).toEqual(["2", "14"])
    expect(computeNextTokens(["1"])).toEqual(["2"])
    expect(computeNextTokens(["3", "1", "1"])).toEqual(["3", "1", "2"])
  })

  it("takes the upper bound on ranges (e.g. 13-14 -> 15)", () => {
    expect(computeNextTokens(["2", "13-14"])).toEqual(["2", "15"])
    expect(computeNextTokens(["2", "13-15"])).toEqual(["2", "16"])
  })

  it("returns null when the last token is non-numeric", () => {
    // Wouldn't normally happen, but worth guarding so the rule fails
    // closed rather than guessing.
    expect(computeNextTokens(["2", "intro"])).toBeNull()
    expect(computeNextTokens([])).toBeNull()
  })

  it("returns null on padded/decorated numerals to keep lookups exact", () => {
    expect(computeNextTokens(["02"])).toBeNull()
    expect(computeNextTokens(["13a"])).toBeNull()
  })
})
