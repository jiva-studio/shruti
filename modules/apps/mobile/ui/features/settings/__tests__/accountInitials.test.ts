import { describe, expect, it } from "vitest"
import { accountInitials } from "../accountInitials.js"

describe("accountInitials", () => {
  it("takes the first and the last word of a full name", () => {
    expect(accountInitials("Test User", null)).toBe("TU")
    expect(accountInitials("A. C. Bhaktivedanta Swami", null)).toBe("AS")
  })

  it("takes one letter from a single-word name", () => {
    expect(accountInitials("madhava", null)).toBe("M")
  })

  it("falls back to the email when there is no name", () => {
    expect(accountInitials(null, "user@example.com")).toBe("U")
    expect(accountInitials("   ", "user@example.com")).toBe("U")
  })

  it("returns nothing when neither is set", () => {
    expect(accountInitials(null, null)).toBe("")
  })
})
