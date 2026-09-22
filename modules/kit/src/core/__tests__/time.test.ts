import { describe, it, expect } from "vitest"
import { MS_PER_DAY, startOfLocalDay, toIsoDate, addDays, daysBetween } from "../time.js"

describe("time", () => {
  it("MS_PER_DAY is 86_400_000", () => {
    expect(MS_PER_DAY).toBe(86_400_000)
  })

  it("startOfLocalDay zeroes the time-of-day", () => {
    const noon = new Date(2026, 5, 6, 12, 34, 56, 789).getTime()
    const midnight = new Date(2026, 5, 6, 0, 0, 0, 0).getTime()
    expect(startOfLocalDay(noon)).toBe(midnight)
  })

  it("startOfLocalDay is idempotent", () => {
    const t = new Date(2026, 0, 1, 9, 0, 0).getTime()
    expect(startOfLocalDay(startOfLocalDay(t))).toBe(startOfLocalDay(t))
  })

  it("toIsoDate formats local YYYY-MM-DD with zero padding", () => {
    expect(toIsoDate(new Date(2026, 0, 9, 23, 59).getTime())).toBe("2026-01-09")
    expect(toIsoDate(new Date(2026, 11, 31).getTime())).toBe("2026-12-31")
  })

  it("addDays crosses month boundaries", () => {
    const jan31 = new Date(2026, 0, 31).getTime()
    expect(toIsoDate(addDays(jan31, 1))).toBe("2026-02-01")
    expect(toIsoDate(addDays(jan31, -1))).toBe("2026-01-30")
  })

  it("daysBetween counts calendar days regardless of time-of-day", () => {
    const a = new Date(2026, 5, 1, 23, 0).getTime()
    const b = new Date(2026, 5, 4, 1, 0).getTime()
    expect(daysBetween(a, b)).toBe(3)
    expect(daysBetween(b, a)).toBe(-3)
  })
})
