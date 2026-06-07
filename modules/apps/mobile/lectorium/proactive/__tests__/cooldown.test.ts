import { describe, expect, it } from "vitest"
import { isWithinCooldown } from "../cooldown.js"

const HOUR = 3_600_000
const NOW = 1_000 * HOUR

describe("isWithinCooldown", () => {
  it("never cools down when cooldown_hours <= 0", () => {
    expect(
      isWithinCooldown({ cooldown_hours: 0 }, { prepState: "ready", createdAt: NOW }, NOW)
    ).toBe(false)
  })

  it("returns false when the rule never fired", () => {
    expect(isWithinCooldown({ cooldown_hours: 24 }, undefined, NOW)).toBe(false)
  })

  it("cools down within the window, releases after it", () => {
    const cfg = { cooldown_hours: 24 }
    const last = { prepState: "ready" as const, createdAt: NOW - 23 * HOUR }
    expect(isWithinCooldown(cfg, last, NOW)).toBe(true)
    expect(isWithinCooldown(cfg, { ...last, createdAt: NOW - 25 * HOUR }, NOW)).toBe(false)
  })

  it("pending / superseded instances don't gate a new one", () => {
    const cfg = { cooldown_hours: 24 }
    expect(isWithinCooldown(cfg, { prepState: "pending", createdAt: NOW }, NOW)).toBe(false)
    expect(isWithinCooldown(cfg, { prepState: "superseded", createdAt: NOW }, NOW)).toBe(false)
  })

  it("dismissed uses the shorter dismiss_resets_after_hours window when set", () => {
    const cfg = { cooldown_hours: 48, dismiss_resets_after_hours: 6 }
    const last = { prepState: "dismissed" as const, createdAt: NOW - 7 * HOUR }
    // 7h since dismissal > 6h dismiss window → released (even though < 48h default)
    expect(isWithinCooldown(cfg, last, NOW)).toBe(false)
    expect(isWithinCooldown(cfg, { ...last, createdAt: NOW - 5 * HOUR }, NOW)).toBe(true)
  })

  it("dismissed falls back to default cooldown when no dismiss window set", () => {
    const cfg = { cooldown_hours: 48 }
    expect(isWithinCooldown(cfg, { prepState: "dismissed", createdAt: NOW - 10 * HOUR }, NOW)).toBe(
      true
    )
  })
})
