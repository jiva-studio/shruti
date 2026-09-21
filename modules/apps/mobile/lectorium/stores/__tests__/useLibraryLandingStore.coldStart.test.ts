import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

// `repositories()` throws until both databases are open, and the landing
// preload runs before the Welcome bootstrap finishes. Every caller fires it as
// `void ensureLoaded()`, so a rejection here has nobody to catch it.
const dbOpen = { value: false }

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => {
      if (!dbOpen.value) throw new Error("repositories(): content DB is not open yet")
      return {
        collections: {
          listGroups: vi.fn().mockResolvedValue([]),
          listCollections: vi.fn().mockResolvedValue([]),
          getGroupCollections: vi.fn().mockResolvedValue([]),
        },
        tracks: { count: vi.fn().mockResolvedValue(1) },
        topics: { topicIdsWithTracksIn: vi.fn().mockResolvedValue([]) },
      }
    },
    filesStorage: {},
  }),
}))
vi.mock("@usecases/discovery/searchAndFilterTracks.js", () => ({
  searchAndFilterTracks: vi.fn().mockResolvedValue([{ id: "t1" }]),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "ru" }),
}))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ({ value: ["ru"] }),
}))
vi.mock("@lectorium/stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({ load: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    topics: [],
    topicShortNamesById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useRecommendationsStore.js", () => ({
  useRecommendationsStore: () => ({ refresh: vi.fn().mockResolvedValue(undefined), shelves: [] }),
}))
vi.mock("@lectorium/services/regionsRegistry.js", () => ({ resolveAssetUrl: (s?: string) => s }))
vi.mock("@lectorium/services/prewarmImageCache.js", () => ({
  prewarmImageCache: vi.fn().mockResolvedValue(undefined),
}))

import { useLibraryLandingStore } from "../useLibraryLandingStore.js"

describe("useLibraryLandingStore on a cold start", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    dbOpen.value = false
  })

  it("degrades to empty instead of rejecting", async () => {
    const store = useLibraryLandingStore()

    await expect(store.ensureLoaded()).resolves.toBeUndefined()

    expect(store.ready).toBe(false)
    expect(store.lecturePool).toEqual([])
  })

  it("loads for real once the databases are open", async () => {
    const store = useLibraryLandingStore()
    await store.ensureLoaded()

    dbOpen.value = true
    await store.ensureLoaded()

    expect(store.ready).toBe(true)
    expect(store.lecturePool).toEqual([{ id: "t1" }])
  })
})
