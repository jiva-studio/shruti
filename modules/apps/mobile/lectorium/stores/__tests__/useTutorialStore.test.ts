import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const prefs = new Map<string, string>()
const prefGet = vi.fn(async (k: string) => prefs.get(k) ?? null)
const prefSet = vi.fn(async (k: string, v: string) => void prefs.set(k, v))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ preferences: { get: prefGet, set: prefSet, remove: vi.fn() } }),
}))

import { useTutorialStore } from "../useTutorialStore.js"

const KEY = "tutorial.v1"

describe("useTutorialStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    prefGet.mockClear()
    prefSet.mockClear()
  })

  it("shows every cue on a fresh install", async () => {
    const s = useTutorialStore()

    await s.load()

    expect(s.flags).toEqual({ player: false, transcriptOpened: false })
    expect(s.loaded).toBe(true)
  })

  it("fills absent flags from the defaults when only some were stored", async () => {
    prefs.set(KEY, JSON.stringify({ player: true }))
    const s = useTutorialStore()

    await s.load()

    expect(s.flags).toEqual({ player: true, transcriptOpened: false })
  })

  it("keeps the defaults when the stored payload is corrupt", async () => {
    prefs.set(KEY, "{oops")
    const s = useTutorialStore()

    await s.load()

    expect(s.flags).toEqual({ player: false, transcriptOpened: false })
    expect(s.loaded).toBe(true)
  })

  it("reads preferences once", async () => {
    const s = useTutorialStore()

    await s.load()
    await s.load()

    expect(prefGet).toHaveBeenCalledOnce()
  })

  it("dismissing one cue leaves the others showing and survives a restart", async () => {
    const s = useTutorialStore()
    await s.load()

    await s.dismiss("player")

    expect(s.flags).toEqual({ player: true, transcriptOpened: false })

    setActivePinia(createPinia())
    const reopened = useTutorialStore()
    await reopened.load()
    expect(reopened.flags).toEqual({ player: true, transcriptOpened: false })
  })

  it("resetting brings every cue back", async () => {
    const s = useTutorialStore()
    await s.dismiss("player")
    await s.dismiss("transcriptOpened")

    await s.reset()

    expect(s.flags).toEqual({ player: false, transcriptOpened: false })
    expect(JSON.parse(prefs.get(KEY)!)).toEqual({ player: false, transcriptOpened: false })
  })
})
