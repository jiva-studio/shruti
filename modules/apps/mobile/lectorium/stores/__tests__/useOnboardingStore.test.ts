import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const prefs = new Map<string, string>()
const prefGet = vi.fn(async (k: string) => prefs.get(k) ?? null)
const prefSet = vi.fn(async (k: string, v: string) => void prefs.set(k, v))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ preferences: { get: prefGet, set: prefSet, remove: vi.fn() } }),
}))

import {
  ONBOARDING_COMPLETED_KEY,
  readOnboardingCompleted,
  useOnboardingStore,
} from "../useOnboardingStore.js"

describe("useOnboardingStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    prefGet.mockClear()
    prefSet.mockClear()
  })

  it("replays onboarding on a fresh install", async () => {
    const s = useOnboardingStore()

    await s.load()

    expect(s.completed).toBe(false)
    expect(s.loaded).toBe(true)
  })

  it("reads a completed flag back as completed", async () => {
    prefs.set(ONBOARDING_COMPLETED_KEY, "true")
    const s = useOnboardingStore()

    await s.load()

    expect(s.completed).toBe(true)
  })

  it("treats any other stored value as not completed", async () => {
    prefs.set(ONBOARDING_COMPLETED_KEY, "yes")
    const s = useOnboardingStore()

    await s.load()

    expect(s.completed).toBe(false)
  })

  it("reads preferences once", async () => {
    const s = useOnboardingStore()

    await s.load()
    await s.load()

    expect(prefGet).toHaveBeenCalledOnce()
  })

  it("marking completed survives into a fresh store", async () => {
    await useOnboardingStore().markCompleted()

    setActivePinia(createPinia())
    const reopened = useOnboardingStore()
    await reopened.load()

    expect(reopened.completed).toBe(true)
  })

  it("resetting replays onboarding on the next launch", async () => {
    const s = useOnboardingStore()
    await s.markCompleted()

    await s.reset()

    expect(s.completed).toBe(false)
    expect(await readOnboardingCompleted({ get: prefGet })).toBe(false)
  })

  it("reads the flag without pinia for startup routing", async () => {
    expect(await readOnboardingCompleted({ get: prefGet })).toBe(false)

    prefs.set(ONBOARDING_COMPLETED_KEY, "true")

    expect(await readOnboardingCompleted({ get: prefGet })).toBe(true)
  })
})
