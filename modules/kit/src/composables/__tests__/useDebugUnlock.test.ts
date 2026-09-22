import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useDebugUnlock } from "../useDebugUnlock.js"

describe("useDebugUnlock", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("unlocks after N taps within the window and fires onUnlock once", () => {
    const onUnlock = vi.fn()
    const d = useDebugUnlock({ taps: 3, windowMs: 1000, onUnlock })

    expect(d.registerTap()).toBe(false)
    expect(d.registerTap()).toBe(false)
    expect(d.unlocked.value).toBe(false)
    expect(d.registerTap()).toBe(true) // crossing tap
    expect(d.unlocked.value).toBe(true)
    expect(onUnlock).toHaveBeenCalledOnce()

    // further taps are no-ops once unlocked
    expect(d.registerTap()).toBe(false)
    expect(onUnlock).toHaveBeenCalledOnce()
  })

  it("resets the counter when taps fall outside the window", () => {
    const d = useDebugUnlock({ taps: 3, windowMs: 1000 })
    d.registerTap()
    d.registerTap()
    vi.advanceTimersByTime(1500) // window elapsed → counter resets
    d.registerTap()
    expect(d.unlocked.value).toBe(false)
    d.registerTap()
    expect(d.registerTap()).toBe(true)
    expect(d.unlocked.value).toBe(true)
  })

  it("uses defaults of 5 taps / 3s", () => {
    const d = useDebugUnlock()
    for (let i = 0; i < 4; i++) expect(d.registerTap()).toBe(false)
    expect(d.registerTap()).toBe(true)
  })

  it("respects an injected clock", () => {
    let t = 0
    const d = useDebugUnlock({ taps: 2, windowMs: 100, now: () => t })
    d.registerTap()
    t = 500 // beyond window
    d.registerTap()
    expect(d.unlocked.value).toBe(false)
    d.registerTap()
    expect(d.unlocked.value).toBe(true)
  })

  it("can start unlocked (rehydrated state)", () => {
    const onUnlock = vi.fn()
    const d = useDebugUnlock({ initialUnlocked: true, onUnlock })
    expect(d.unlocked.value).toBe(true)
    expect(d.registerTap()).toBe(false)
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it("unlock() forces unlock and fires onUnlock", () => {
    const onUnlock = vi.fn()
    const d = useDebugUnlock({ onUnlock })
    d.unlock()
    expect(d.unlocked.value).toBe(true)
    expect(onUnlock).toHaveBeenCalledOnce()
    d.unlock()
    expect(onUnlock).toHaveBeenCalledOnce()
  })

  it("lock() returns to locked and clears the counter", () => {
    const d = useDebugUnlock({ taps: 2, windowMs: 1000 })
    d.registerTap()
    d.registerTap()
    expect(d.unlocked.value).toBe(true)
    d.lock()
    expect(d.unlocked.value).toBe(false)
    expect(d.registerTap()).toBe(false) // counter was cleared
  })
})
