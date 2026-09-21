import { describe, expect, it } from "vitest"
import { tintFor } from "../tint.js"

describe("tintFor", () => {
  it("gives the same title the same pair every time", () => {
    expect(tintFor("Bhagavad-gita 2.13")).toEqual(tintFor("Bhagavad-gita 2.13"))
  })

  it("separates the two stops by a fixed hue step", () => {
    const [a, b] = tintFor("Srimad Bhagavatam")
    const hue = (s: string) => Number(/^hsl\((\d+)/.exec(s)![1])
    expect((hue(a) + 38) % 360).toBe(hue(b))
  })

  it("keeps the hue in range for a title of any length", () => {
    for (const title of ["", "a", "x".repeat(500), "श्रीमद् भागवतम्"]) {
      const hue = Number(/^hsl\((\d+)/.exec(tintFor(title)[0])![1])
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it("walks the string by code point, so an astral char is one step", () => {
    expect(tintFor("\u{1F418}")).toEqual(tintFor("\u{1F418}"))
    expect(tintFor("\u{1F418}")).not.toEqual(tintFor("\u{1F418}\u{1F418}"))
  })
})
