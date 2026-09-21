import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { clearLogs, recordError } from "@lectorium/services/logger/index.js"
import { useLogsStore } from "../useLogsStore.js"

/** The store coalesces appends onto the next frame. */
async function nextFrame(): Promise<void> {
  await new Promise((r) => setTimeout(r, 32))
}

describe("useLogsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearLogs()
  })

  it("starts from whatever the buffer already holds", () => {
    recordError("before the store existed")

    const s = useLogsStore()

    expect(s.count).toBe(1)
    expect(s.entries[0].text).toBe("before the store existed")
  })

  it("shows the newest line first", async () => {
    const s = useLogsStore()

    recordError("first")
    recordError("second")
    await nextFrame()

    expect(s.entries.map((e) => e.text)).toEqual(["second", "first"])
    expect(s.count).toBe(2)
  })

  it("re-derives after a burst of appends", async () => {
    const s = useLogsStore()
    expect(s.count).toBe(0)

    for (let i = 0; i < 20; i++) recordError(`line ${i}`)
    await nextFrame()

    expect(s.count).toBe(20)
    expect(s.entries[0].text).toBe("line 19")
  })

  it("dumps the buffer oldest-first with a timestamp and level", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
    recordError("boom")
    vi.useRealTimers()
    const s = useLogsStore()

    expect(s.asText()).toBe("2026-01-02T03:04:05.000Z ERROR boom")
  })

  it("joins several lines oldest-first", () => {
    recordError("one")
    recordError("two")
    const s = useLogsStore()

    const lines = s.asText().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0].endsWith("one")).toBe(true)
    expect(lines[1].endsWith("two")).toBe(true)
  })

  it("clearing empties the viewer", async () => {
    const s = useLogsStore()
    recordError("noise")
    await nextFrame()
    expect(s.count).toBe(1)

    s.clear()
    await nextFrame()

    expect(s.count).toBe(0)
    expect(s.entries).toEqual([])
    expect(s.asText()).toBe("")
  })
})
