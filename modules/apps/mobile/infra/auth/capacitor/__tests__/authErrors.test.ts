import { describe, expect, it } from "vitest"
import {
  accountDeleteErrorFromStatus,
  emailOtpErrorFromResponse,
  isConnectivityError,
} from "../authErrors.js"

function response(status: number, headers: Record<string, string> = {}): Response {
  return { status, headers: new Headers(headers) } as Response
}

describe("isConnectivityError", () => {
  it("recognises the wrapped fetch failure by name", () => {
    const e = Object.assign(new Error("offline"), { name: "NetworkError" })
    expect(isConnectivityError(e)).toBe(true)
  })

  it("recognises a raw TypeError, for a caller with an unwrapped request fn", () => {
    expect(isConnectivityError(new TypeError("Failed to fetch"))).toBe(true)
  })

  it("does not take a server fault for the user's internet", () => {
    expect(isConnectivityError(new Error("HTTP 503"))).toBe(false)
    expect(isConnectivityError(null)).toBe(false)
    expect(isConnectivityError("offline")).toBe(false)
  })
})

describe("emailOtpErrorFromResponse", () => {
  it("names each status the user can act on", () => {
    expect(emailOtpErrorFromResponse(response(400)).kind).toBe("invalid-email")
    expect(emailOtpErrorFromResponse(response(401)).kind).toBe("invalid-code")
    expect(emailOtpErrorFromResponse(response(503)).kind).toBe("disabled")
  })

  it("carries the retry delay of a throttled request", () => {
    const e = emailOtpErrorFromResponse(response(429, { "Retry-After": "30" }))
    expect(e.kind).toBe("throttled")
    expect(e.retryAfter).toBe(30)
  })

  it("throttles without a delay when the server named none", () => {
    expect(emailOtpErrorFromResponse(response(429)).retryAfter).toBeUndefined()
  })

  it("separates a server fault from an unknown one", () => {
    expect(emailOtpErrorFromResponse(response(500)).kind).toBe("server")
    expect(emailOtpErrorFromResponse(response(418)).kind).toBe("unknown")
  })
})

describe("accountDeleteErrorFromStatus", () => {
  it("names each status", () => {
    expect(accountDeleteErrorFromStatus(401).kind).toBe("unauthorized")
    expect(accountDeleteErrorFromStatus(410).kind).toBe("already-deleted")
    expect(accountDeleteErrorFromStatus(429).kind).toBe("rate-limited")
    expect(accountDeleteErrorFromStatus(502).kind).toBe("server")
    expect(accountDeleteErrorFromStatus(418).kind).toBe("unknown")
  })

  it("carries the status through", () => {
    expect(accountDeleteErrorFromStatus(502).status).toBe(502)
  })
})
