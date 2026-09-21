import { describe, expect, it } from "vitest"
import { formatHourMinute, localDate, localTime } from "../proactiveClock.js"

describe("localDate", () => {
  it("pads month and day", () => {
    expect(localDate(new Date(2026, 0, 5, 12, 0))).toBe("2026-01-05")
  })

  it("reads the device's own day, not the UTC one", () => {
    const late = new Date(2026, 6, 31, 23, 59)
    expect(localDate(late)).toBe("2026-07-31")
  })
})

describe("localTime", () => {
  it("pads both halves", () => {
    expect(localTime(new Date(2026, 0, 5, 9, 7))).toBe("09:07")
    expect(localTime(new Date(2026, 0, 5, 0, 0))).toBe("00:00")
  })
})

describe("formatHourMinute", () => {
  it("formats the settings pair", () => {
    expect(formatHourMinute([7, 30])).toBe("07:30")
  })

  it("falls back to the default reminder time", () => {
    expect(formatHourMinute(undefined)).toBe("09:00")
  })
})
