import { describe, it, expect, vi } from "vitest"
import { NetworkError, withNetworkErrorContext } from "../networkError.js"

const ok = new Response("", { status: 200 })

describe("withNetworkErrorContext", () => {
  it("passes a successful response through untouched", async () => {
    const wrapped = withNetworkErrorContext(vi.fn().mockResolvedValue(ok))
    expect(await wrapped("/auth/anonymous", { method: "POST" })).toBe(ok)
  })

  it("passes an HTTP-status response through (failover returns 4xx/5xx, not throws)", async () => {
    const res = new Response("", { status: 503 })
    const wrapped = withNetworkErrorContext(vi.fn().mockResolvedValue(res))
    expect(await wrapped("/chat")).toBe(res)
  })

  it("rethrows a fetch network failure as a NetworkError naming method + path", async () => {
    const cause = new TypeError("Failed to fetch")
    const wrapped = withNetworkErrorContext(vi.fn().mockRejectedValue(cause))

    const err = await wrapped("/anonymous", { method: "post" }).catch((e) => e)
    expect(err).toBeInstanceOf(NetworkError)
    expect(err.method).toBe("POST")
    expect(err.path).toBe("/anonymous")
    expect(err.message).toBe("POST /anonymous — network unreachable")
    expect(err.cause).toBe(cause)
  })

  it("defaults the method to GET when none is given", async () => {
    const wrapped = withNetworkErrorContext(
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    )
    const err = await wrapped("/me").catch((e) => e)
    expect(err.message).toBe("GET /me — network unreachable")
  })

  it("passes an AbortError through unchanged (caller cancelled, not a fault)", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const wrapped = withNetworkErrorContext(vi.fn().mockRejectedValue(abort))
    await expect(wrapped("/chat")).rejects.toBe(abort)
  })

  it("does not double-wrap an already-named NetworkError", async () => {
    const already = new NetworkError("POST", "/inner")
    const wrapped = withNetworkErrorContext(vi.fn().mockRejectedValue(already))
    await expect(wrapped("/outer")).rejects.toBe(already)
  })
})
