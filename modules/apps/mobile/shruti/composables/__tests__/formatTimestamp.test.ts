import { describe, expect, it } from "vitest"
import { formatTimestamp } from "../formatTimestamp.js"

describe("formatTimestamp", () => {
  it("formats sub-minute timestamps as 00:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00")
    expect(formatTimestamp(5_000)).toBe("00:05")
    expect(formatTimestamp(59_000)).toBe("00:59")
  })

  it("formats sub-hour timestamps as MM:SS with leading zero padding", () => {
    expect(formatTimestamp(60_000)).toBe("01:00")
    expect(formatTimestamp(300_000)).toBe("05:00")
    expect(formatTimestamp(720_000)).toBe("12:00")
    expect(formatTimestamp(1_500_000)).toBe("25:00")
    expect(formatTimestamp(3_599_000)).toBe("59:59")
  })

  it("formats hour+ timestamps as H:MM:SS with padded minutes and seconds", () => {
    expect(formatTimestamp(3_600_000)).toBe("1:00:00")
    expect(formatTimestamp(3_665_000)).toBe("1:01:05")
    expect(formatTimestamp(5_400_000)).toBe("1:30:00")
    expect(formatTimestamp(36_000_000)).toBe("10:00:00")
  })

  it("handles negative, non-finite, and zero values safely", () => {
    expect(formatTimestamp(-1000)).toBe("00:00")
    expect(formatTimestamp(NaN)).toBe("00:00")
    expect(formatTimestamp(Infinity)).toBe("00:00")
    expect(formatTimestamp(-Infinity)).toBe("00:00")
  })
})
