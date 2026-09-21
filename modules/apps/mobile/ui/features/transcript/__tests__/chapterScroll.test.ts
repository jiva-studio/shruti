import { describe, expect, it } from "vitest"
import { headingScrollTop } from "../chapterScroll.js"

describe("headingScrollTop", () => {
  it("lands the heading a small gap below the top edge", () => {
    expect(headingScrollTop(200, 500, 100)).toBe(588)
  })

  it("never scrolls above the top of the content", () => {
    expect(headingScrollTop(0, 100, 100)).toBe(0)
    expect(headingScrollTop(0, 50, 100)).toBe(0)
  })
})
