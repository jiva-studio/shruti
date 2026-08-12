import { describe, expect, it } from "vitest"
import { isPrepStale } from "../staleness.js"

const HOUR_MS = 3_600_000
const NOW = 1_700_000_000_000

describe("isPrepStale", () => {
  it("treats a never-prepped row as stale so it gets its first body", () => {
    expect(isPrepStale({ preparedAt: null }, 24, NOW)).toBe(true)
  })

  it("is false inside the refresh window and true past it", () => {
    expect(isPrepStale({ preparedAt: NOW - 23 * HOUR_MS }, 24, NOW)).toBe(false)
    expect(isPrepStale({ preparedAt: NOW - 25 * HOUR_MS }, 24, NOW)).toBe(true)
  })

  // #1770: the inline-hint rules ship `refresh_if_older_than_hours: 9999`
  // precisely so their body is never rebuilt. That only holds while
  // `preparedAt` is in the same unit as the clock — the seconds stamp
  // `attach()` used to write made every marker look ~55 years old, and the
  // rebuild overwrote the host answer's content and actions.
  it("does not consider a freshly attached cooldown row stale", () => {
    expect(isPrepStale({ preparedAt: NOW }, 9999, NOW)).toBe(false)
  })

  it("keeps a cooldown row fresh for the whole 9999-hour window", () => {
    expect(isPrepStale({ preparedAt: NOW - 9998 * HOUR_MS }, 9999, NOW)).toBe(false)
  })
})
