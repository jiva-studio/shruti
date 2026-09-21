import { describe, expect, it } from "vitest"
import { releasesComposeLock } from "../composeLockWatchers.js"

describe("releasesComposeLock", () => {
  it("releases on sign-in, sign-out and account switch alike", () => {
    expect(releasesComposeLock("identity", "u-1", null)).toBe(true)
    expect(releasesComposeLock("identity", null, "u-1")).toBe(true)
    expect(releasesComposeLock("identity", "u-2", "u-1")).toBe(true)
    expect(releasesComposeLock("identity", "u-1", "u-1")).toBe(false)
  })

  it("releases on the upgrade to Pro but not on its expiry", () => {
    expect(releasesComposeLock("entitlement", true, false)).toBe(true)
    expect(releasesComposeLock("entitlement", false, true)).toBe(false)
    expect(releasesComposeLock("entitlement", true, true)).toBe(false)
  })

  it("releases on a rotated quota bucket, but not on the initial restore", () => {
    expect(releasesComposeLock("quota", "q-2", "q-1")).toBe(true)
    expect(releasesComposeLock("quota", "q-1", "")).toBe(false)
    expect(releasesComposeLock("quota", "", "q-1")).toBe(false)
    expect(releasesComposeLock("quota", "q-1", "q-1")).toBe(false)
  })

  it("releases when an anonymous session is linked in place", () => {
    expect(releasesComposeLock("authorized", true, false)).toBe(true)
    expect(releasesComposeLock("authorized", false, true)).toBe(false)
  })
})
