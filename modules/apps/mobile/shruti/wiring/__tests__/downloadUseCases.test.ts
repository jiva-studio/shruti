import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Shruti } from "@shruti/shruti.js"
import type { StallWatch } from "@usecases/downloads/downloadPorts.js"

const reportError = vi.hoisted(() => vi.fn())
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError }))

import { useDownloadUseCases } from "../downloadUseCases.js"

function platformWith(getQueueState: () => Promise<unknown>) {
  const app = { audioPlayer: { getQueueState } } as unknown as Shruti
  return useDownloadUseCases(app).platform(() => ({}) as StallWatch)
}

beforeEach(() => {
  reportError.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useDownloadUseCases — platform", () => {
  it("reports an engine queue that cannot be read and treats it as empty", async () => {
    const boom = new Error("bridge gone")

    expect(await platformWith(() => Promise.reject(boom)).loadedQueueItem()).toBeNull()
    expect(reportError).toHaveBeenCalledWith("downloads", boom)
  })

  it("schedules on the platform's timers, and the returned call disarms them", () => {
    const { schedule } = platformWith(async () => null)
    const fired = vi.fn()
    const disarmed = vi.fn()

    schedule(fired, 1_000)
    schedule(disarmed, 1_000)()
    vi.advanceTimersByTime(999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(fired).toHaveBeenCalledOnce()
    expect(disarmed).not.toHaveBeenCalled()
  })
})
