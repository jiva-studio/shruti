import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

// The lecture-pool query under test. We assert the filter args it receives.
const searchAndFilterTracks = vi.fn().mockResolvedValue([{ id: "t1" }])
// The scoped-count query — must receive the same library-language scope.
const tracksCount = vi.fn().mockResolvedValue(0)
// The topic-language filter query. Returns the topic ids that have a lecture in
// the requested library languages; tests set the resolved value per case.
const topicIdsWithTracksIn = vi.fn().mockResolvedValue([])

// The topics dictionary the tile grid draws from. A test can swap this in.
let dictionaryTopics: { id: string }[] = []

// Library languages are driven by a writable holder so each test can set them
// before the store loads.
const libraryLanguagesRef = { value: [] as string[] }

vi.mock("@usecases/discovery/searchAndFilterTracks.js", () => ({
  searchAndFilterTracks: (...args: unknown[]) => searchAndFilterTracks(...args),
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      // Collections return empty so the load path exercises only the lecture
      // pool / count, which is what we assert.
      collections: {
        listGroups: vi.fn().mockResolvedValue([]),
        listCollections: vi.fn().mockResolvedValue([]),
        getGroupCollections: vi.fn().mockResolvedValue([]),
      },
      tracks: { count: tracksCount },
      topics: { topicIdsWithTracksIn },
    }),
    filesStorage: {},
  }),
}))

vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "ru" }),
}))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguagesRef,
}))
// The landing store awaits the filter store's seed before querying; the
// library languages themselves are driven by `libraryLanguagesRef` above, so
// the seed load just needs to resolve.
vi.mock("@lectorium/stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({
    load: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    get topics() {
      return dictionaryTopics
    },
    topicShortNamesById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useRecommendationsStore.js", () => ({
  useRecommendationsStore: () => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    shelves: [],
  }),
}))
vi.mock("@lectorium/services/regionsRegistry.js", () => ({
  resolveAssetUrl: (s?: string) => s,
}))
vi.mock("@lectorium/services/prewarmImageCache.js", () => ({
  prewarmImageCache: vi.fn().mockResolvedValue(undefined),
}))

import { useLibraryLandingStore } from "../useLibraryLandingStore.js"

describe("useLibraryLandingStore — language scoping", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Reset, not clear: a test that installs its own implementation must not
    // leak it into the next one.
    searchAndFilterTracks.mockReset().mockResolvedValue([{ id: "t1" }])
    tracksCount.mockReset().mockResolvedValue(0)
    topicIdsWithTracksIn.mockClear()
    topicIdsWithTracksIn.mockResolvedValue([])
    dictionaryTopics = []
    libraryLanguagesRef.value = []
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("scopes the lecture pool + count by the LIBRARY languages, not the UI language", async () => {
    libraryLanguagesRef.value = ["en"]
    const store = useLibraryLandingStore()
    await store.ensureLoaded()

    // The pool query carries the library languages — UI language is "ru" here,
    // so a UI-driven query would have used ["ru"].
    const poolArgs = searchAndFilterTracks.mock.calls[0][0] as { languageCodes?: string[] }
    expect(poolArgs.languageCodes).toEqual(["en"])

    // The scoped count uses the same library scope.
    expect(tracksCount).toHaveBeenCalledWith({ languageCodes: ["en"] })
  })

  it("an EMPTY library-language set yields an unfiltered query (languageCodes: undefined)", async () => {
    libraryLanguagesRef.value = []
    const store = useLibraryLandingStore()
    await store.ensureLoaded()

    const poolArgs = searchAndFilterTracks.mock.calls[0][0] as { languageCodes?: string[] }
    expect(poolArgs.languageCodes).toBeUndefined()

    // count gets `undefined` (no filter object) on an empty set.
    expect(tracksCount).toHaveBeenCalledWith(undefined)
  })

  it("hides topic tiles with no lecture in the selected library languages", async () => {
    libraryLanguagesRef.value = ["en"]
    dictionaryTopics = [{ id: "topic-en" }, { id: "topic-ru-only" }]
    // Only topic-en has an English lecture; topic-ru-only is excluded.
    topicIdsWithTracksIn.mockResolvedValue(["topic-en"])

    const store = useLibraryLandingStore()
    await store.ensureLoaded()

    expect(topicIdsWithTracksIn).toHaveBeenCalledWith(["en"])
    const tileIds = store.topicTiles.map((t) => t.id)
    expect(tileIds).toEqual(["topic-en"])
  })

  // Issue #1741 (5): `ensureLoaded` coalesces only same-key calls, and `load`
  // carried no generation token — so a language switch mid-load left two loads
  // writing the same refs, and the slower (older) one won.
  it("a language switch mid-load is not overwritten by the older language", async () => {
    let enQueryStarted!: () => void
    const enQueryRunning = new Promise<void>((resolve) => {
      enQueryStarted = resolve
    })
    let releaseEn!: () => void
    const enQueryGate = new Promise<void>((resolve) => {
      releaseEn = resolve
    })
    searchAndFilterTracks.mockImplementation(async (input: { languageCodes?: string[] }) => {
      if (input.languageCodes?.[0] === "en") {
        enQueryStarted()
        await enQueryGate
        return [{ id: "en-lecture" }]
      }
      return [{ id: "ru-lecture" }]
    })
    tracksCount.mockImplementation(async (filters?: { languageCodes?: string[] }) =>
      filters?.languageCodes?.[0] === "en" ? 1111 : 2222
    )

    libraryLanguagesRef.value = ["en"]
    const store = useLibraryLandingStore()
    const englishLoad = store.ensureLoaded()
    await enQueryRunning

    // The user switches the library to Russian while English is still loading.
    libraryLanguagesRef.value = ["ru"]
    await store.ensureLoaded()
    // …and only now does the English catalog query come back.
    releaseEn()
    await englishLoad

    expect(store.lecturePool.map((t) => t.id)).toEqual(["ru-lecture"])
    expect(store.lectureCount).toBe(2222)
  })

  it("does NOT filter topic tiles when no library language is selected", async () => {
    libraryLanguagesRef.value = []
    dictionaryTopics = [{ id: "topic-en" }, { id: "topic-ru-only" }]

    const store = useLibraryLandingStore()
    await store.ensureLoaded()

    // No language filter ⇒ the query is skipped and every topic stays.
    expect(topicIdsWithTracksIn).not.toHaveBeenCalled()
    const tileIds = store.topicTiles.map((t) => t.id).sort()
    expect(tileIds).toEqual(["topic-en", "topic-ru-only"])
  })
})
