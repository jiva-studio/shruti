import { describe, expect, it } from "vitest"
import { createChatGapCursor } from "../chatGapStore.js"
import type { ISyncMarkerStore } from "../syncEnginePorts.js"

function store(initial: Record<string, string> = {}, opts: { failing?: boolean } = {}) {
  const prefs = new Map(Object.entries(initial))
  const fail = async () => {
    throw new Error("prefs unavailable")
  }
  const markers: ISyncMarkerStore = opts.failing
    ? { get: fail, set: fail, remove: fail }
    : {
        get: async (k) => prefs.get(k) ?? null,
        set: async (k, v) => void prefs.set(k, v),
        remove: async (k) => void prefs.delete(k),
      }
  return { prefs, gap: createChatGapCursor(markers) }
}

// Installed builds read this preference key: pinned as a literal.
describe("createChatGapCursor", () => {
  it("reads the floor stored under sync.chatGapCursor", async () => {
    expect(await store({ "sync.chatGapCursor": "40" }).gap.read()).toBe(40)
    expect(await store({ "sync.chatGapCursor": "0" }).gap.read()).toBe(0)
  })

  it.each(["-1", "abc", "Infinity"])("reads a corrupt floor %s as no gap", async (raw) => {
    expect(await store({ "sync.chatGapCursor": raw }).gap.read()).toBeNull()
  })

  it("reads no gap when nothing is stored or the store is unavailable", async () => {
    expect(await store().gap.read()).toBeNull()
    expect(await store({}, { failing: true }).gap.read()).toBeNull()
  })

  it("writes the floor and clears it on null", async () => {
    const s = store()
    await s.gap.write(12)
    expect(Object.fromEntries(s.prefs)).toEqual({ "sync.chatGapCursor": "12" })
    await s.gap.write(null)
    expect(s.prefs.size).toBe(0)
  })

  it("swallows a failed write", async () => {
    await expect(store({}, { failing: true }).gap.write(3)).resolves.toBeUndefined()
  })
})
