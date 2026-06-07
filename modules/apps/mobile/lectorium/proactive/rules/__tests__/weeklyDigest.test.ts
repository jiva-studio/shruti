import { describe, expect, it } from "vitest"
import { nextSundayFrom } from "../weeklyDigest.js"

// SUNDAY_NOTIFY_HOUR is 9 in the rule; the same-Sunday boundary turns
// on that hour.
describe("nextSundayFrom", () => {
  it("targets TODAY when it's Sunday and before the notify hour", () => {
    // 2026-06-07 is a Sunday; 08:00 is before 09:00.
    const sunday = nextSundayFrom(new Date(2026, 5, 7, 8, 0, 0))
    expect(sunday.getFullYear()).toBe(2026)
    expect(sunday.getMonth()).toBe(5)
    expect(sunday.getDate()).toBe(7)
    expect(sunday.getDay()).toBe(0)
  })

  it("rolls to next Sunday when it's Sunday but already past the notify hour", () => {
    // Same Sunday, but 10:00 is past 09:00 — the morning digest moment
    // is gone, so aim a week out.
    const sunday = nextSundayFrom(new Date(2026, 5, 7, 10, 0, 0))
    expect(sunday.getDate()).toBe(14)
    expect(sunday.getDay()).toBe(0)
  })

  it("targets the upcoming Sunday on a weekday", () => {
    // 2026-06-03 is a Wednesday → next Sunday is 2026-06-07.
    const sunday = nextSundayFrom(new Date(2026, 5, 3, 12, 0, 0))
    expect(sunday.getDate()).toBe(7)
    expect(sunday.getDay()).toBe(0)
  })

  it("normalizes the result to the start of the day", () => {
    const sunday = nextSundayFrom(new Date(2026, 5, 3, 23, 59, 59))
    expect(sunday.getHours()).toBe(0)
    expect(sunday.getMinutes()).toBe(0)
    expect(sunday.getSeconds()).toBe(0)
  })
})
