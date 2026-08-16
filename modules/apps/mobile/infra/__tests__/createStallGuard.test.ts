import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createStallGuard, DOWNLOAD_STALL_TIMEOUT_MS } from "@infra/watchDownload.js"

// The rule the media bridge dies by, on its own. Split out of `watchDownload`
// so the share-audio path — which sees bytes through the port's `onProgress`
// callback and has no task id to subscribe to — ends a stalled transfer by the
// same measure instead of a second number pretending to be the same one
// (#1889).
describe("createStallGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires once the silence budget elapses, without ever being pinged", () => {
    const onStall = vi.fn()
    createStallGuard({ onStall })

    vi.advanceTimersByTime(DOWNLOAD_STALL_TIMEOUT_MS - 1)
    expect(onStall).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect((onStall.mock.calls[0]![0] as Error).message).toContain("stalled")
  })

  it("lets a slow-but-live transfer survive: every ping restarts the budget", () => {
    const onStall = vi.fn()
    const guard = createStallGuard({ onStall })

    // Ten times longer than the budget, but never silent for it.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(DOWNLOAD_STALL_TIMEOUT_MS - 1_000)
      guard.ping()
    }
    expect(onStall).not.toHaveBeenCalled()

    // Silence from the last ping is what ends it.
    vi.advanceTimersByTime(DOWNLOAD_STALL_TIMEOUT_MS)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it("stays quiet after cancel", () => {
    const onStall = vi.fn()
    const guard = createStallGuard({ onStall })
    guard.cancel()

    vi.advanceTimersByTime(DOWNLOAD_STALL_TIMEOUT_MS * 3)
    expect(onStall).not.toHaveBeenCalled()
  })

  it("names the transfer in the error and honours a custom budget", () => {
    const onStall = vi.fn()
    createStallGuard({ onStall, label: "Share audio download", stallTimeoutMs: 1_000 })

    vi.advanceTimersByTime(1_000)
    expect((onStall.mock.calls[0]![0] as Error).message).toBe(
      "Share audio download stalled: no progress for 1s"
    )
  })
})
