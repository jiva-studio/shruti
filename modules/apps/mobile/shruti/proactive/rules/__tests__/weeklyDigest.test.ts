import { describe, expect, it } from "vitest"
import { nextMondayFrom } from "../weeklyDigest.js"

// MONDAY_NOTIFY_HOUR is 9 in the rule; the same-Monday boundary turns
// on that hour. (2026-06-08 is a Monday, 2026-06-07 the Sunday before.)
describe("nextMondayFrom", () => {
  it("targets TODAY when it's Monday and before the notify hour", () => {
    // 2026-06-08 is a Monday; 08:00 is before 09:00.
    const monday = nextMondayFrom(new Date(2026, 5, 8, 8, 0, 0))
    expect(monday.getFullYear()).toBe(2026)
    expect(monday.getMonth()).toBe(5)
    expect(monday.getDate()).toBe(8)
    expect(monday.getDay()).toBe(1)
  })

  it("rolls to next Monday when it's Monday but already past the notify hour", () => {
    // Same Monday, but 10:00 is past 09:00 — the morning digest moment
    // is gone, so aim a week out.
    const monday = nextMondayFrom(new Date(2026, 5, 8, 10, 0, 0))
    expect(monday.getDate()).toBe(15)
    expect(monday.getDay()).toBe(1)
  })

  it("targets the upcoming Monday on a weekday", () => {
    // 2026-06-03 is a Wednesday → next Monday is 2026-06-08.
    const monday = nextMondayFrom(new Date(2026, 5, 3, 12, 0, 0))
    expect(monday.getDate()).toBe(8)
    expect(monday.getDay()).toBe(1)
  })

  it("targets tomorrow when it's Sunday", () => {
    // 2026-06-07 is a Sunday → next Monday is the very next day.
    const monday = nextMondayFrom(new Date(2026, 5, 7, 12, 0, 0))
    expect(monday.getDate()).toBe(8)
    expect(monday.getDay()).toBe(1)
  })

  it("normalizes the result to the start of the day", () => {
    const monday = nextMondayFrom(new Date(2026, 5, 3, 23, 59, 59))
    expect(monday.getHours()).toBe(0)
    expect(monday.getMinutes()).toBe(0)
    expect(monday.getSeconds()).toBe(0)
  })
})
