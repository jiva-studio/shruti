import { describe, expect, it } from "vitest"
import { classifyIdentityChange, tierDisagrees } from "../rcIdentity.js"

const anon = (userId: string | null) => ({ userId, anonymous: true })
const named = (userId: string | null) => ({ userId, anonymous: false })

describe("classifyIdentityChange", () => {
  it("names the first identity of the session a sign-in", () => {
    expect(classifyIdentityChange(anon("a-1"), undefined)).toBe("signIn")
    expect(classifyIdentityChange(named("u-1"), anon(null))).toBe("signIn")
  })

  it("separates an anonymous session linked in place from a real account switch", () => {
    expect(classifyIdentityChange(named("u-1"), anon("a-1"))).toBe("crossLink")
    expect(classifyIdentityChange(named("u-2"), named("u-1"))).toBe("accountSwitch")
  })

  it("names a dropped identity a sign-out", () => {
    expect(classifyIdentityChange(anon(null), named("u-1"))).toBe("signOut")
  })

  it("stays silent when nothing that matters changed", () => {
    expect(classifyIdentityChange(named("u-1"), named("u-1"))).toBe("none")
    expect(classifyIdentityChange(anon(null), undefined)).toBe("none")
    expect(classifyIdentityChange(anon(null), anon(null))).toBe("none")
  })
})

describe("tierDisagrees", () => {
  it("is true only when RevenueCat and the raw server tier point apart", () => {
    expect(tierDisagrees(true, "free")).toBe(true)
    expect(tierDisagrees(false, "pro")).toBe(true)
    expect(tierDisagrees(true, "pro")).toBe(false)
    expect(tierDisagrees(false, "free")).toBe(false)
  })
})
