import { describe, expect, it } from "vitest"
import { isNagDue, isPastGrace } from "../nagCooldown.js"

const DAY = 24 * 60 * 60 * 1000

describe("isNagDue", () => {
  it("is due when it has never been dismissed", () => {
    expect(isNagDue(null, 0, 14 * DAY)).toBe(true)
  })

  it("stays quiet inside the cooldown", () => {
    expect(isNagDue(0, 13 * DAY, 14 * DAY)).toBe(false)
  })

  it("comes back once the cooldown has elapsed", () => {
    expect(isNagDue(0, 14 * DAY, 14 * DAY)).toBe(true)
  })
})

describe("isPastGrace", () => {
  it("stays quiet while the install date is unknown", () => {
    expect(isPastGrace(null, 99 * DAY, 7 * DAY)).toBe(false)
  })

  it("stays quiet during the first week", () => {
    expect(isPastGrace(0, 6 * DAY, 7 * DAY)).toBe(false)
  })

  it("allows the ask once the week is up", () => {
    expect(isPastGrace(0, 7 * DAY, 7 * DAY)).toBe(true)
  })
})
