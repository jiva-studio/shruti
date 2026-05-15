import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withProgressLabels, type LabelStep } from "../withProgressLabels.js"

describe("withProgressLabels", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const schedule: ReadonlyArray<LabelStep> = [
    { atMs: 5_000, label: "rendering" },
    { atMs: 45_000, label: "almost" },
    { atMs: 90_000, label: "still" },
  ]

  it("returns the wrapped task's result, no label fired if task settles before first threshold", async () => {
    const setLabel = vi.fn()
    const task = Promise.resolve("done")

    const result = await withProgressLabels(task, schedule, setLabel)

    expect(result).toBe("done")
    expect(setLabel).not.toHaveBeenCalled()
  })

  it("propagates rejection without swallowing", async () => {
    const setLabel = vi.fn()
    const task = Promise.reject(new Error("boom"))

    await expect(withProgressLabels(task, schedule, setLabel)).rejects.toThrow("boom")
  })

  it("fires labels in order as wall time elapses", async () => {
    const setLabel = vi.fn()
    let resolveTask: (v: string) => void
    const task = new Promise<string>((r) => {
      resolveTask = r
    })

    const wrapped = withProgressLabels(task, schedule, setLabel)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(setLabel).toHaveBeenLastCalledWith("rendering")

    await vi.advanceTimersByTimeAsync(40_000) // total 46s
    expect(setLabel).toHaveBeenLastCalledWith("almost")

    await vi.advanceTimersByTimeAsync(50_000) // total 96s
    expect(setLabel).toHaveBeenLastCalledWith("still")

    resolveTask!("done")
    await wrapped

    // Each label should have fired exactly once (no duplicates).
    expect(setLabel).toHaveBeenCalledTimes(3)
  })

  it("clears the interval after task settles (no leaks)", async () => {
    const setLabel = vi.fn()
    let resolveTask: (v: string) => void
    const task = new Promise<string>((r) => {
      resolveTask = r
    })
    const wrapped = withProgressLabels(task, schedule, setLabel)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(setLabel).toHaveBeenCalledTimes(1)

    resolveTask!("done")
    await wrapped

    setLabel.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(setLabel).not.toHaveBeenCalled()
  })
})
