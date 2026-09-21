import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isTransientStatus,
  newIdempotencyKey,
  parseRetryAfterMs,
  resolveAccessToken,
  safeReadText,
  sleep,
} from "../chatHttp.js"

/** A response whose body errors mid-read, the way a dropped connection does. */
function unreadableResponse(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("connection reset"))
    },
  })
  return new Response(body, { status })
}

describe("resolveAccessToken", () => {
  it("returns the token the provider answered with", async () => {
    await expect(resolveAccessToken(async () => "token-1")).resolves.toBe("token-1")
  })

  it("fails the call when the session can no longer produce a token", async () => {
    await expect(resolveAccessToken(async () => null)).rejects.toThrow(
      "auth.getAccessToken returned null"
    )
  })

  it("fails the call on a blank token rather than sending an empty bearer", async () => {
    await expect(resolveAccessToken(async () => "")).rejects.toThrow("session unrecoverable")
  })

  it("propagates a provider that throws instead of answering", async () => {
    await expect(
      resolveAccessToken(async () => {
        throw new Error("refresh failed")
      })
    ).rejects.toThrow("refresh failed")
  })
})

describe("isTransientStatus", () => {
  it("treats gateway and redeploy statuses as worth retrying", () => {
    expect([502, 503, 504].map(isTransientStatus)).toEqual([true, true, true])
  })

  it("does not retry a request timeout, which retrying only compounds", () => {
    expect(isTransientStatus(408)).toBe(false)
  })

  it("does not retry success, client errors or a plain server error", () => {
    expect([200, 400, 401, 429, 500].map(isTransientStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe("newIdempotencyKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns a distinct key on each call", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey())
  })

  it("uses the platform uuid when the runtime offers one", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-3333-4444-555555555555" })

    expect(newIdempotencyKey()).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("still produces distinct keys on a runtime without randomUUID", () => {
    vi.stubGlobal("crypto", {})

    const first = newIdempotencyKey()
    const second = newIdempotencyKey()

    expect(first).toMatch(/^\d+-[a-z0-9]+$/)
    expect(second).not.toBe(first)
  })
})

describe("parseRetryAfterMs", () => {
  it("falls back when the server sent no header", () => {
    expect(parseRetryAfterMs(null, 2500)).toBe(2500)
  })

  it("reads a delay in seconds as milliseconds", () => {
    expect(parseRetryAfterMs("3", 2500)).toBe(3000)
  })

  it("caps a long delay at a minute so a bad header cannot pin the client", () => {
    expect(parseRetryAfterMs("86400", 2500)).toBe(60_000)
  })

  it("falls back for a zero or negative delay", () => {
    expect(parseRetryAfterMs("0", 2500)).toBe(2500)
    expect(parseRetryAfterMs("-5", 2500)).toBe(2500)
  })

  it("falls back for the HTTP-date form and for anything unparseable", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", 2500)).toBe(2500)
    expect(parseRetryAfterMs("", 2500)).toBe(2500)
  })
})

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves once the delay has elapsed, not before", async () => {
    vi.useFakeTimers()
    let done = false
    const waiting = sleep(1000).then(() => {
      done = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(done).toBe(true)
  })

  it("returns straight away when the caller already gave up", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()

    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined()
  })

  it("resolves early when the caller gives up mid-wait", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let done = false
    const waiting = sleep(60_000, controller.signal).then(() => {
      done = true
    })

    controller.abort()
    await waiting

    expect(done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("safeReadText", () => {
  it("returns the body the server sent", async () => {
    await expect(safeReadText(new Response("upstream is unhappy", { status: 500 }))).resolves.toBe(
      "upstream is unhappy"
    )
  })

  it("returns an empty body as an empty string", async () => {
    await expect(safeReadText(new Response("", { status: 200 }))).resolves.toBe("")
  })

  it("falls back to the status when the body cannot be read", async () => {
    await expect(safeReadText(unreadableResponse(503))).resolves.toBe("HTTP 503")
  })
})
