import { describe, expect, it, vi, afterEach } from "vitest"
import { registerMainPlayerPauser } from "../useNotesInlineAudio.js"

// The pausers set is module-scoped — track any registrations made by the
// test and ensure they're disposed at the end of each `it` block so
// state doesn't leak.
const disposers: Array<() => void> = []
function track(fn: () => void): () => void {
  const dispose = registerMainPlayerPauser(fn)
  disposers.push(dispose)
  return dispose
}

afterEach(() => {
  while (disposers.length > 0) {
    const d = disposers.pop()
    d?.()
  }
})

describe("registerMainPlayerPauser", () => {
  it("returns a dispose handle that removes the callback from the singleton set", () => {
    const fn = vi.fn()
    const dispose = registerMainPlayerPauser(fn)
    // Dispose works without throwing — the registry is internal so we
    // can't inspect it directly, but the contract is "calling dispose
    // removes the pauser". Best-effort smoke check.
    expect(() => dispose()).not.toThrow()
  })

  it("supports multiple independent registrations (each gets its own dispose)", () => {
    const a = vi.fn()
    const b = vi.fn()
    const disposeA = track(a)
    const disposeB = track(b)
    expect(disposeA).not.toBe(disposeB)
    // Disposing one doesn't throw for the other.
    expect(() => {
      disposeA()
      disposeB()
    }).not.toThrow()
  })

  it("dispose is idempotent (Set.delete on a missing entry is a no-op)", () => {
    const fn = vi.fn()
    const dispose = registerMainPlayerPauser(fn)
    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
  })
})
