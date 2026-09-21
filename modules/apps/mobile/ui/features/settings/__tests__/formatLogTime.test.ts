import { describe, expect, it } from "vitest"
import { formatLogTime } from "../formatLogTime.js"

describe("formatLogTime", () => {
  it("pads every field so the lines stay column-aligned", () => {
    const ts = new Date(2026, 0, 2, 3, 4, 5, 6).getTime()

    expect(formatLogTime(ts)).toBe("03:04:05.006")
  })

  it("keeps the 24-hour clock", () => {
    const ts = new Date(2026, 0, 2, 23, 59, 59, 999).getTime()

    expect(formatLogTime(ts)).toBe("23:59:59.999")
  })
})
