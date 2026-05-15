import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pollUntilReady } from "../pollUntilReady.js"

describe("pollUntilReady", () => {
  const fetchMock = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  function ok(): Response {
    return new Response(null, { status: 200 })
  }

  function notFound(): Response {
    return new Response(null, { status: 404 })
  }

  it("returns immediately when first probe is 200 (no-op poll for cache hits)", async () => {
    fetchMock.mockResolvedValueOnce(ok())

    await pollUntilReady("https://cdn/path")

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://cdn/path")
    expect((init as RequestInit | undefined)?.method).toBe("HEAD")
  })

  it("polls at intervalMs cadence until 200", async () => {
    fetchMock
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(ok())

    const promise = pollUntilReady("https://cdn/path", { intervalMs: 1000 })

    // First probe runs synchronously; advance the wait between probes.
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("throws after timeoutMs", async () => {
    fetchMock.mockResolvedValue(notFound())

    const promise = pollUntilReady("https://cdn/path", {
      timeoutMs: 5_000,
      intervalMs: 1_000,
    })
    // Surface the rejection so the unhandled-rejection handler doesn't fail the test.
    const settled = promise.catch((e) => e)
    await vi.advanceTimersByTimeAsync(6_000)
    const err = await settled
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out/i)
  })

  it("rejects on external abort", async () => {
    fetchMock.mockResolvedValue(notFound())

    const ctrl = new AbortController()
    const promise = pollUntilReady("https://cdn/path", {
      intervalMs: 1_000,
      signal: ctrl.signal,
    })
    const settled = promise.catch((e) => e)

    await vi.advanceTimersByTimeAsync(500)
    ctrl.abort(new Error("user-cancelled"))
    const err = await settled
    expect((err as Error).message).toBe("user-cancelled")
  })

  it("treats network errors / probe timeouts as miss (keeps polling)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(ok())

    const promise = pollUntilReady("https://cdn/path", { intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
