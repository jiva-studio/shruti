import { describe, expect, it, vi } from "vitest"
import { emitNotify, onNotify, type NotifyIntent } from "../notifyEvents.js"

const intent: NotifyIntent = {
  title: "Sadhu replied",
  body: "Your answer is ready",
  sessionId: "s1",
  notificationId: 7,
  whenBackground: "notify",
}

describe("the notify bus", () => {
  it("hands every subscriber the intent as given", () => {
    const seen: NotifyIntent[] = []
    const off = onNotify((i) => seen.push(i))
    emitNotify(intent)
    expect(seen).toEqual([intent])
    off()
  })

  it("stops reaching one that unsubscribed", () => {
    const fn = vi.fn()
    onNotify(fn)()
    emitNotify(intent)
    expect(fn).not.toHaveBeenCalled()
  })

  it("keeps going when one subscriber throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const good = vi.fn()
    const offBad = onNotify(() => {
      throw new Error("bad")
    })
    const offGood = onNotify(good)
    expect(() => emitNotify(intent)).not.toThrow()
    expect(good).toHaveBeenCalledWith(intent)
    offBad()
    offGood()
    vi.restoreAllMocks()
  })

  it("carries a skip-in-background intent unchanged", () => {
    let got: NotifyIntent | null = null
    const off = onNotify((i) => {
      got = i
    })
    emitNotify({ title: "t", body: "b", whenBackground: "skip" })
    expect(got).toEqual({ title: "t", body: "b", whenBackground: "skip" })
    off()
  })
})
