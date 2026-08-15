import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  isChatStreamPath,
  RequestTimeoutError,
  withRequestTimeout,
} from "../requestTimeout.js"

/**
 * The failure this decorator exists for is NOT offline — `fetch` rejects
 * immediately there and every `finally` runs. It is a socket that completes the
 * handshake and then never answers, which reaches JS as a promise that never
 * settles. So the fake transport below never settles; a mock that rejects would
 * pass without the fix.
 */
function neverSettles(): {
  request: (path: string, init?: RequestInit) => Promise<Response>
  lastInit: () => RequestInit | undefined
} {
  let seen: RequestInit | undefined
  return {
    request: (_path, init) => {
      seen = init
      // Settles on abort and only on abort — exactly what `fetch` does with a
      // socket the far end never writes to.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true }
        )
      })
    },
    lastInit: () => seen,
  }
}

describe("withRequestTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("passes a normal response straight through", async () => {
    const ok = new Response("", { status: 200 })
    const wrapped = withRequestTimeout(vi.fn().mockResolvedValue(ok))
    await expect(wrapped("/profile/sync/pull", { method: "POST" })).resolves.toBe(ok)
  })

  it("rejects a request that never settles, once the budget is spent", async () => {
    const transport = neverSettles()
    const wrapped = withRequestTimeout(transport.request, { timeoutMs: 5_000 })

    const settled = vi.fn()
    const result = wrapped("/refresh", { method: "POST" }).catch(settled)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    await result
    const err = settled.mock.calls[0]![0] as RequestTimeoutError
    expect(err).toBeInstanceOf(RequestTimeoutError)
    expect(err.name).toBe("TimeoutError")
    expect(err.message).toBe("POST /refresh — no response within 5000ms")
  })

  it("aborts the socket rather than racing it, so nothing is left open", async () => {
    const transport = neverSettles()
    const wrapped = withRequestTimeout(transport.request, { timeoutMs: 1_000 })

    void wrapped("/discovery/search", { method: "POST" }).catch(() => {})
    const signal = transport.lastInit()!.signal!
    expect(signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1_001)
    expect(signal.aborted).toBe(true)
  })

  it("leaves the chat turn stream unbounded", async () => {
    const transport = neverSettles()
    const wrapped = withRequestTimeout(transport.request, {
      timeoutMs: 1_000,
      skip: isChatStreamPath,
    })

    const settled = vi.fn()
    void wrapped("/chat", { method: "POST" }).then(settled, settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 10)
    expect(settled).not.toHaveBeenCalled()
    // The caller's own signal is forwarded untouched — `chatClient` owns the
    // stream's header + stall deadlines and its Stop button.
    expect(transport.lastInit()!.signal).toBeUndefined()
  })

  it("still bounds the non-streaming chat routes", async () => {
    const transport = neverSettles()
    const wrapped = withRequestTimeout(transport.request, {
      timeoutMs: 1_000,
      skip: isChatStreamPath,
    })

    const failed = wrapped("/chat/feedback", { method: "POST" }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await failed).toBeInstanceOf(RequestTimeoutError)
  })

  it("bridges the caller's signal and rethrows ITS abort unchanged", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const controller = new AbortController()
    const request = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abort), { once: true })
        })
    )
    const wrapped = withRequestTimeout(request, { timeoutMs: 10_000 })

    const failed = wrapped("/discovery/search", {
      method: "POST",
      signal: controller.signal,
    }).catch((e) => e)
    controller.abort()

    // A newer search cancelled this one: not our deadline, not a fault.
    await expect(failed).resolves.toBe(abort)
  })

  it("aborts immediately when the caller's signal is already aborted", async () => {
    const transport = neverSettles()
    const wrapped = withRequestTimeout(transport.request)
    void wrapped("/discovery/search", { signal: AbortSignal.abort() }).catch(() => {})
    expect(transport.lastInit()!.signal!.aborted).toBe(true)
  })
})
