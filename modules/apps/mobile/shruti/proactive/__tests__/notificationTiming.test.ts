import { describe, expect, it } from "vitest"
import { resolveProactiveFireTime } from "../notificationTiming.js"

describe("resolveProactiveFireTime", () => {
  // A fixed "now": 2026-06-07 09:00 local.
  const now = new Date(2026, 5, 7, 9, 0, 0).getTime()

  it("fires exactly at visible_at for a future event", () => {
    const future = new Date(2026, 5, 7, 18, 0, 0).getTime()
    expect(resolveProactiveFireTime(future, now)).toBe(future)
  })

  it("fires ~5s out for an event earlier today", () => {
    const earlierToday = new Date(2026, 5, 7, 7, 0, 0).getTime()
    expect(resolveProactiveFireTime(earlierToday, now)).toBe(now + 5_000)
  })

  it("skips an event from a previous day", () => {
    const yesterday = new Date(2026, 5, 6, 20, 0, 0).getTime()
    expect(resolveProactiveFireTime(yesterday, now)).toBeNull()
  })

  it("skips an event from a future day even if its clock time already passed today", () => {
    const tomorrow = new Date(2026, 5, 8, 8, 0, 0).getTime()
    expect(resolveProactiveFireTime(tomorrow, now)).toBe(tomorrow)
  })
})
