import { describe, expect, it, vi } from "vitest"
import {
  emitTurnSettled,
  emitTurnStarted,
  onTurnSettled,
  onTurnStarted,
  type TurnSettledEvent,
  type TurnStartedEvent,
} from "../turnNotificationEvents.js"

const started: TurnStartedEvent = { assistantMessageId: "m1", sessionId: "s1" }

describe("turn-started", () => {
  it("reaches its subscribers with the event as given", () => {
    const seen: TurnStartedEvent[] = []
    const off = onTurnStarted((e) => seen.push(e))
    emitTurnStarted(started)
    expect(seen).toEqual([started])
    off()
  })

  it("does not reach the settled subscribers", () => {
    const settled = vi.fn()
    const off = onTurnSettled(settled)
    emitTurnStarted(started)
    expect(settled).not.toHaveBeenCalled()
    off()
  })

  it("keeps going when one subscriber throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const good = vi.fn()
    const offBad = onTurnStarted(() => {
      throw new Error("bad")
    })
    const offGood = onTurnStarted(good)
    expect(() => emitTurnStarted(started)).not.toThrow()
    expect(good).toHaveBeenCalledWith(started)
    offBad()
    offGood()
    vi.restoreAllMocks()
  })
})

describe("turn-settled", () => {
  it("carries the outcome and the silent flag", () => {
    const seen: TurnSettledEvent[] = []
    const off = onTurnSettled((e) => seen.push(e))
    emitTurnSettled({ assistantMessageId: "m1", sessionId: "s1", ok: true, silent: true })
    emitTurnSettled({ assistantMessageId: "m2", sessionId: "s1", ok: false })
    expect(seen).toEqual([
      { assistantMessageId: "m1", sessionId: "s1", ok: true, silent: true },
      { assistantMessageId: "m2", sessionId: "s1", ok: false },
    ])
    off()
  })

  it("stops reaching one that unsubscribed", () => {
    const fn = vi.fn()
    onTurnSettled(fn)()
    emitTurnSettled({ assistantMessageId: "m1", sessionId: "s1", ok: true })
    expect(fn).not.toHaveBeenCalled()
  })

  it("keeps going when one subscriber throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const good = vi.fn()
    const offBad = onTurnSettled(() => {
      throw new Error("bad")
    })
    const offGood = onTurnSettled(good)
    expect(() =>
      emitTurnSettled({ assistantMessageId: "m1", sessionId: "s1", ok: true })
    ).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    offBad()
    offGood()
    vi.restoreAllMocks()
  })
})
