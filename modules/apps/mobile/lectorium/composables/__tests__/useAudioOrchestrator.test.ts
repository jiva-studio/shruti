import { describe, it, expect, vi, beforeEach } from "vitest"
import { registerAudioSource, pauseGroup } from "../useAudioOrchestrator.js"

// The orchestrator is a module singleton. These tests exercise the
// non-Vue API (registerAudioSource / pauseGroup); the useAudioSource
// wrapper just adds onBeforeUnmount cleanup on top and is covered by
// component tests. Each test releases everything it registers so state
// doesn't leak between cases.

describe("useAudioOrchestrator", () => {
  let registered: Array<() => void>

  beforeEach(() => {
    registered = []
  })

  function add(kind: "main" | "inline", pause: () => void): { claim: () => void } {
    const handle = registerAudioSource(kind, pause)
    registered.push(handle.release)
    return { claim: handle.claim }
  }

  function cleanup(): void {
    registered.forEach((release) => release())
  }

  it("claim pauses every other source but not itself", () => {
    const a = vi.fn()
    const b = vi.fn()
    const sourceA = add("inline", a)
    add("inline", b)

    sourceA.claim()

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("claim is symmetric across kinds (inline pauses main, main pauses inline)", () => {
    const mainPause = vi.fn()
    const inlinePause = vi.fn()
    const main = add("main", mainPause)
    const inline = add("inline", inlinePause)

    // Inline snippet starts → main lecture pauses.
    inline.claim()
    expect(mainPause).toHaveBeenCalledTimes(1)
    expect(inlinePause).not.toHaveBeenCalled()

    // Main lecture starts → inline snippet pauses.
    main.claim()
    expect(inlinePause).toHaveBeenCalledTimes(1)
    expect(mainPause).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it("pauseGroup('inline') pauses only inline sources, leaving main playing", () => {
    const mainPause = vi.fn()
    const inlineA = vi.fn()
    const inlineB = vi.fn()
    add("main", mainPause)
    add("inline", inlineA)
    add("inline", inlineB)

    pauseGroup("inline")

    expect(inlineA).toHaveBeenCalledTimes(1)
    expect(inlineB).toHaveBeenCalledTimes(1)
    expect(mainPause).not.toHaveBeenCalled()
    cleanup()
  })

  it("released sources are no longer paused", () => {
    const a = vi.fn()
    const b = vi.fn()
    const sourceA = add("inline", a)
    const handleB = registerAudioSource("inline", b)

    handleB.release()
    sourceA.claim()

    expect(b).not.toHaveBeenCalled()
    cleanup()
  })

  it("a throwing pause callback does not block the rest", () => {
    const boom = vi.fn(() => {
      throw new Error("nope")
    })
    const ok = vi.fn()
    add("inline", boom)
    add("inline", ok)

    expect(() => pauseGroup("inline")).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
