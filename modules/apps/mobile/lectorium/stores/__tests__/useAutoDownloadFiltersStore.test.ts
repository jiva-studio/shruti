import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { DurationFilterId } from "@lib/domain/durationFilters.js"

const store = new Map<string, string>()
const prefGet = vi.fn(async (k: string) => store.get(k) ?? null)
const prefSet = vi.fn(async (k: string, v: string) => void store.set(k, v))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ preferences: { get: prefGet, set: prefSet, remove: vi.fn() } }),
}))

import { useAutoDownloadFiltersStore } from "../useAutoDownloadFiltersStore.js"

const KEY = "autoDownload.filters.v1"

function persisted(): Record<string, unknown> {
  return JSON.parse(store.get(KEY) ?? "{}")
}

describe("useAutoDownloadFiltersStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.clear()
    prefGet.mockClear()
    prefSet.mockClear()
  })

  it("starts empty and writes nothing on a first load — no filter means the whole library", async () => {
    const s = useAutoDownloadFiltersStore()

    await s.load()

    expect(s.loaded).toBe(true)
    expect(s.languageCodes).toEqual([])
    expect(s.sort).toBeUndefined()
    expect(prefSet).not.toHaveBeenCalled()
  })

  it("restores a previously persisted selection", async () => {
    store.set(KEY, JSON.stringify({ authorIds: ["a1"], languageCodes: ["ru"], sort: "byDateDesc" }))
    const s = useAutoDownloadFiltersStore()

    await s.load()

    expect(s.authorIds).toEqual(["a1"])
    expect(s.languageCodes).toEqual(["ru"])
    expect(s.sort).toBe("byDateDesc")
    expect(s.locationIds).toEqual([])
  })

  it("ignores a corrupt payload and stays empty", async () => {
    store.set(KEY, "{not json")
    const s = useAutoDownloadFiltersStore()

    await s.load()

    expect(s.loaded).toBe(true)
    expect(s.authorIds).toEqual([])
  })

  it("does not re-read preferences once loaded", async () => {
    const s = useAutoDownloadFiltersStore()

    await s.load()
    await s.load()

    expect(prefGet).toHaveBeenCalledOnce()
  })

  it("persists every setter under its own key", async () => {
    const s = useAutoDownloadFiltersStore()

    await s.setAuthors(["a1"])
    await s.setLanguages(["en", "ru"])
    await s.setLocations(["l1"])
    await s.setSources(["s1"])
    await s.setTags(["tg1"])
    await s.setTopics(["tp1"])
    await s.setDuration(["short"] as DurationFilterId[])
    await s.setSort("byDateAsc")
    await s.setDateFrom("1972")
    await s.setDateTo("1975-06")

    expect(persisted()).toEqual({
      authorIds: ["a1"],
      languageCodes: ["en", "ru"],
      locationIds: ["l1"],
      sourceIds: ["s1"],
      tagIds: ["tg1"],
      topicIds: ["tp1"],
      duration: ["short"],
      sort: "byDateAsc",
      dateFrom: "1972",
      dateTo: "1975-06",
    })
  })

  it("survives a round trip through a fresh store", async () => {
    await useAutoDownloadFiltersStore().setTopics(["tp1", "tp2"])

    setActivePinia(createPinia())
    const reopened = useAutoDownloadFiltersStore()
    await reopened.load()

    expect(reopened.topicIds).toEqual(["tp1", "tp2"])
  })

  it("clearAll wipes the selection and persists the empty tuple", async () => {
    const s = useAutoDownloadFiltersStore()
    await s.setAuthors(["a1"])
    await s.setSort("byDateAsc")

    await s.clearAll()

    expect(s.authorIds).toEqual([])
    expect(s.sort).toBeUndefined()
    expect(persisted().authorIds).toEqual([])
  })

  it("reset drops in-memory state without touching what is persisted", async () => {
    const s = useAutoDownloadFiltersStore()
    await s.setAuthors(["a1"])
    await s.load()

    s.reset()

    expect(s.authorIds).toEqual([])
    expect(s.loaded).toBe(false)
    expect(persisted().authorIds).toEqual(["a1"])

    await s.load()
    expect(s.authorIds).toEqual(["a1"])
  })
})
