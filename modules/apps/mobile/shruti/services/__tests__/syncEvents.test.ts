import { describe, expect, it, vi } from "vitest"
import { onSyncEvent, requestSync } from "../syncEvents.js"

describe("the sync bus", () => {
  it("reaches every subscriber", () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = onSyncEvent("sync-requested", a)
    const offB = onSyncEvent("sync-requested", b)
    requestSync()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
  })

  it("stops reaching one that unsubscribed", () => {
    const fn = vi.fn()
    onSyncEvent("sync-requested", fn)()
    requestSync()
    expect(fn).not.toHaveBeenCalled()
  })

  it("registers the same function once", () => {
    const fn = vi.fn()
    const off1 = onSyncEvent("sync-requested", fn)
    const off2 = onSyncEvent("sync-requested", fn)
    requestSync()
    expect(fn).toHaveBeenCalledTimes(1)
    off1()
    off2()
  })

  it("keeps going when one subscriber throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const good = vi.fn()
    const offBad = onSyncEvent("sync-requested", () => {
      throw new Error("bad")
    })
    const offGood = onSyncEvent("sync-requested", good)
    expect(() => requestSync()).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    offBad()
    offGood()
    vi.restoreAllMocks()
  })

  it("is a no-op when nobody is listening", () => {
    expect(() => requestSync()).not.toThrow()
  })
})
