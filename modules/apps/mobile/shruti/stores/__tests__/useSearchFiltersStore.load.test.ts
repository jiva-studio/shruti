import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const prefs = new Map<string, string>()
const prefGet = vi.fn(async (k: string) => prefs.get(k) ?? null)
const prefSet = vi.fn(async (k: string, v: string) => void prefs.set(k, v))
const listWithTracks = vi.fn<() => Promise<{ code: string }[]>>()
let locale = "ru"

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@shruti/i18n/index.js", () => ({
  detectDeviceLocaleAsync: () => Promise.resolve(locale),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    preferences: { get: prefGet, set: prefSet, remove: vi.fn() },
    repositories: () => ({ languages: { listWithTracks } }),
  }),
}))

import { useSearchFiltersStore } from "../useSearchFiltersStore.js"

const KEY = "search.filters.v3"

describe("useSearchFiltersStore.load", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    prefGet.mockClear()
    prefSet.mockClear()
    locale = "ru"
    listWithTracks.mockResolvedValue([{ code: "ru" }, { code: "en" }])
  })

  it("seeds the locale language and an ascending sort on a first launch", async () => {
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.languageCodes).toEqual(["ru"])
    expect(s.sort).toBe("byDateAsc")
    expect(s.localeLanguageDefault).toEqual(["ru"])
    expect(s.loaded).toBe(true)
  })

  it("persists a catalog-derived seed so it survives a restart", async () => {
    const s = useSearchFiltersStore()

    await s.load()

    expect(JSON.parse(prefs.get(KEY)!)).toMatchObject({
      languageCodes: ["ru"],
      sort: "byDateAsc",
    })
  })

  it("keeps a seed guessed without the catalog for this session only", async () => {
    listWithTracks.mockResolvedValue([])
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.languageCodes).toEqual(["ru"])
    expect(prefSet).not.toHaveBeenCalled()
  })

  it("treats a failing catalog read as no catalog rather than propagating", async () => {
    listWithTracks.mockRejectedValue(new Error("db closed"))
    const s = useSearchFiltersStore()

    await expect(s.load()).resolves.toBeUndefined()

    expect(s.languageCodes).toEqual(["ru"])
    expect(prefSet).not.toHaveBeenCalled()
  })

  it("reduces a UI locale with no lectures of its own to a content language", async () => {
    locale = "uk"
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.languageCodes).toEqual(["ru"])
  })

  it("restores the stored selection instead of seeding", async () => {
    prefs.set(KEY, JSON.stringify({ languageCodes: ["en"], authorIds: ["a1"], sort: "byDateDesc" }))
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.languageCodes).toEqual(["en"])
    expect(s.authorIds).toEqual(["a1"])
    expect(s.sort).toBe("byDateDesc")
    expect(prefSet).not.toHaveBeenCalled()
  })

  it("keeps an explicitly emptied language selection rather than re-seeding it", async () => {
    prefs.set(KEY, JSON.stringify({ languageCodes: [] }))
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.languageCodes).toEqual([])
    expect(s.localeLanguageDefault).toEqual(["ru"])
  })

  // A payload that will not parse used to be treated as a deliberate empty
  // selection: no language filter at all, which is the whole multi-language
  // library. It is not a choice the user made, so it seeds like a first launch.
  it.each([
    ["unparseable", "{oops"],
    ["not an object", "[1,2,3]"],
    ["a bare string", '"nonsense"'],
  ])("seeds from the locale when the stored payload is %s", async (_label, payload) => {
    prefs.set(KEY, payload)
    const s = useSearchFiltersStore()

    await s.load()

    expect(s.loaded).toBe(true)
    expect(s.languageCodes).toEqual(["ru"])
    expect(s.sort).toBe("byDateAsc")
  })

  it("does not re-seed on a second load", async () => {
    const s = useSearchFiltersStore()

    await s.load()
    prefSet.mockClear()
    await s.load()

    expect(prefGet).toHaveBeenCalledOnce()
    expect(prefSet).not.toHaveBeenCalled()
  })

  it("re-seeds after a reset", async () => {
    const s = useSearchFiltersStore()
    await s.load()
    await s.setAuthors(["a1"])

    s.reset()

    expect(s.authorIds).toEqual([])
    expect(s.loaded).toBe(false)
  })

  it("clearAll empties every facet and persists the result", async () => {
    const s = useSearchFiltersStore()
    await s.load()
    await s.setAuthors(["a1"])
    await s.setTopics(["tp1"])

    await s.clearAll()

    expect(s.authorIds).toEqual([])
    expect(s.topicIds).toEqual([])
    expect(s.languageCodes).toEqual([])
    expect(JSON.parse(prefs.get(KEY)!).authorIds).toEqual([])
  })

  it("persists each facet setter", async () => {
    const s = useSearchFiltersStore()

    await s.setLocations(["l1"])
    await s.setSources(["s1"])
    await s.setTags(["tg1"])
    await s.setDuration([])
    await s.setDateFrom("1972")
    await s.setDateTo("1975-06")

    expect(JSON.parse(prefs.get(KEY)!)).toMatchObject({
      locationIds: ["l1"],
      sourceIds: ["s1"],
      tagIds: ["tg1"],
      dateFrom: "1972",
      dateTo: "1975-06",
    })
  })
})
