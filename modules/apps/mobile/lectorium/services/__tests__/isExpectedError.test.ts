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

  it("drops expected errors from plain-object rejections (Capacitor plugins, console.error(obj))", () => {
    // Capacitor plugin errors + `console.error(obj)` arrive as plain
    // `{code, message}` objects, not Error instances.
    expect(
      isExpectedError({
        code: "OS-PLUG-FILE-0010",
        message: "Directory at '/…/databases/' already exists, cannot be overwritten.",
      })
    ).toBe(true)
    expect(
      isExpectedError({
        code: "OS-PLUG-FILE-0008",
        message: "'stat' failed because file … does not exist.",
      })
    ).toBe(true)
    // Auto-download loop racing the content-DB open on startup (LETORIUM-6).
    expect(isExpectedError({ message: "repositories(): content DB is not open yet" })).toBe(true)
  })

  it("drops transient/environmental RevenueCat errors by numeric-string code", () => {
    // NETWORK_ERROR — "Error performing request." on flaky mobile networks.
    expect(isExpectedError({ code: "10", message: "Error performing request." })).toBe(true)
    // STORE_PROBLEM / PRODUCT_REQUEST_TIMED_OUT / OFFLINE_CONNECTION
    expect(isExpectedError({ code: "2" })).toBe(true)
    expect(isExpectedError({ code: "32" })).toBe(true)
    expect(isExpectedError({ code: "35" })).toBe(true)
    // CONFIGURATION_ERROR ("23", empty offerings) is NOT silenced — the store
    // reports it at warning level so a real store-wide outage stays visible.
    expect(
      isExpectedError({
        code: "23",
        message:
          "There is an issue with your configuration. … None of the products … could be fetched",
      })
    ).toBe(false)
    // A non-listed RC code (e.g. an unexpected backend fault) still pages.
    expect(isExpectedError({ code: "99", message: "unexpected purchase fault" })).toBe(false)
  })

  it("drops expected connectivity errors on flaky mobile networks", () => {
    expect(
      isExpectedError({ name: "NetworkError", message: "POST /anonymous — network unreachable" })
    ).toBe(true)
    expect(isExpectedError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isExpectedError(new Error("All servers are unreachable"))).toBe(true)
    expect(
      isExpectedError(new Error("A network error has occurred. Сетевое соединение потеряно."))
    ).toBe(true)
    expect(isExpectedError(new Error("The Internet connection appears to be offline."))).toBe(true)
    // iOS AVPlayer seek superseded/interrupted — benign.
    expect(isExpectedError(new Error("Seek operation failed"))).toBe(true)
    // A concrete backend fault is a distinct signature and still pages.
    expect(isExpectedError(new Error("HTTP 500 Internal Server Error"))).toBe(false)
  })

  it("keeps real failures", () => {
    expect(isExpectedError(new Error("RevenueCat configure failed"))).toBe(false)
    expect(isExpectedError(new TypeError("x is not a function"))).toBe(false)
    // "Load failed" is NOT deny-listed: a failed dynamic import (broken deploy)
    // surfaces as `TypeError: Load failed` on iOS WebKit and must stay visible;
    // "download failed" must not be swallowed as a substring of it either.
    expect(isExpectedError(new TypeError("Load failed"))).toBe(false)
    expect(isExpectedError(new Error("[studio] download failed"))).toBe(false)
    // A read-only write failure (disk full / permissions) means nothing persists
    // — a real fault, not benign control flow.
    expect(isExpectedError(new Error("attempt to write a readonly database"))).toBe(false)
    expect(isExpectedError("network request failed")).toBe(false)
  })

  it("handles non-error inputs without throwing", () => {
    expect(isExpectedError(undefined)).toBe(false)
    expect(isExpectedError(null)).toBe(false)
    expect(isExpectedError(42)).toBe(false)
    expect(isExpectedError({})).toBe(false)
  })
})
