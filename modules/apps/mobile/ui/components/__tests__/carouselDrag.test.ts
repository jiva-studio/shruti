import { describe, expect, it } from "vitest"
import { lockDragAxis, resistOutOfBounds } from "../carouselDrag.js"

describe("lockDragAxis", () => {
  it("waits until either axis has travelled past the threshold", () => {
    expect(lockDragAxis(5, 5, 8, "horizontal")).toBeNull()
    expect(lockDragAxis(-9, 0, 8, "horizontal")).toBe("horizontal")
    expect(lockDragAxis(0, -9, 8, "vertical")).toBe("vertical")
  })

  it("gives the gesture to the dominant axis", () => {
    expect(lockDragAxis(30, 10, 8, "horizontal")).toBe("horizontal")
    expect(lockDragAxis(10, 30, 8, "horizontal")).toBe("vertical")
    expect(lockDragAxis(10, 30, 8, "vertical")).toBe("vertical")
    expect(lockDragAxis(30, 10, 8, "vertical")).toBe("horizontal")
  })

  it("leaves an exact diagonal to the other axis", () => {
    expect(lockDragAxis(20, 20, 8, "horizontal")).toBe("vertical")
    expect(lockDragAxis(20, 20, 8, "vertical")).toBe("horizontal")
  })
})

describe("resistOutOfBounds", () => {
  it("passes an in-bounds drag through untouched", () => {
    expect(resistOutOfBounds(40, 1, 3, 0.3)).toBe(40)
    expect(resistOutOfBounds(-40, 1, 3, 0.3)).toBe(-40)
  })

  it("damps a drag pulling before the first page", () => {
    expect(resistOutOfBounds(40, 0, 3, 0.3)).toBeCloseTo(12)
    expect(resistOutOfBounds(-40, 0, 3, 0.3)).toBe(-40)
  })

  it("damps a drag pulling past the last page", () => {
    expect(resistOutOfBounds(-40, 2, 3, 0.3)).toBeCloseTo(-12)
    expect(resistOutOfBounds(40, 2, 3, 0.3)).toBe(40)
  })
})
