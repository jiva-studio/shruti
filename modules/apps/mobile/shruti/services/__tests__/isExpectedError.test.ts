import { describe, expect, it } from "vitest"
import { isExpectedError } from "../monitoring/isExpectedError.js"

describe("isExpectedError", () => {
  it("drops expected control-flow errors by message", () => {
    for (const msg of [
      "Directory already exists",
      "File does not exist",
      "no such table: collections",
      "no such column: outline",
      "cannot start a transaction within a transaction",
      "no transaction is active",
      "The operation was aborted",
      "The device or user is not allowed to make the purchase.",
    ]) {
      expect(isExpectedError(new Error(msg)), msg).toBe(true)
    }
  })

  it("drops expected errors by class name", () => {
    expect(isExpectedError({ name: "AbortError", message: "x" })).toBe(true)
    expect(isExpectedError({ name: "PurchaseCancelledError" })).toBe(true)
    expect(isExpectedError({ name: "PurchaseNotAllowedError" })).toBe(true)
    // JSON.parse failures on cached blobs (every such site has a fallback)
    expect(isExpectedError(new SyntaxError("Unexpected token < in JSON"))).toBe(true)
  })

  it("keeps real failures", () => {
    expect(isExpectedError(new Error("RevenueCat configure failed"))).toBe(false)
    expect(isExpectedError(new TypeError("x is not a function"))).toBe(false)
    expect(isExpectedError("network request failed")).toBe(false)
  })

  it("handles non-error inputs without throwing", () => {
    expect(isExpectedError(undefined)).toBe(false)
    expect(isExpectedError(null)).toBe(false)
    expect(isExpectedError(42)).toBe(false)
    expect(isExpectedError({})).toBe(false)
  })
})
