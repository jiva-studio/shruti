import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { RecommendationShelf } from "@usecases/discovery/buildRecommendations.js"

const ensureLoaded = vi.fn(async () => {})
const filtersLoad = vi.fn(async () => {})
const completedTrackIds = new Set<string>()
const hasTrack = vi.fn<(id: TrackId) => boolean>(() => false)
const libraryLanguages = ref<readonly LanguageCode[]>(["ru"] as LanguageCode[])

const { buildRecommendations } = vi.hoisted(() => ({ buildRecommendations: vi.fn() }))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ repositories: () => ({ marker: "repos" }) }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ ensureLoaded, completedTrackIds, hasTrack }),
}))
vi.mock("@lectorium/stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({ load: filtersLoad }),
}))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguages,
}))
vi.mock("@usecases/discovery/buildRecommendations.js", () => ({ buildRecommendations }))

import { useRecommendationsStore } from "../useRecommendationsStore.js"

const TRACK = { id: "t-1" as TrackId } as Track
const SHELF = { topicId: "tp-1", tracks: [TRACK] } as unknown as RecommendationShelf

describe("useRecommendationsStore.refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    completedTrackIds.clear()
    hasTrack.mockReturnValue(false)
    libraryLanguages.value = ["ru"] as LanguageCode[]
    buildRecommendations.mockResolvedValue({
      recommended: [TRACK],
      shelves: [SHELF],
      hasHistory: true,
    })
  })

  it("publishes the built shelves and clears the loading flag", async () => {
    const s = useRecommendationsStore()
    expect(s.isLoading).toBe(false)

    await s.refresh()

    expect(s.recommended).toEqual([TRACK])
    expect(s.shelves).toEqual([SHELF])
    expect(s.hasHistory).toBe(true)
    expect(s.isLoading).toBe(false)
  })

  it("settles the playlist and the language seed before building", async () => {
    const order: string[] = []
    ensureLoaded.mockImplementation(async () => void order.push("playlist"))
    filtersLoad.mockImplementation(async () => void order.push("filters"))
    buildRecommendations.mockImplementation(async () => {
      order.push("build")
      return { recommended: [], shelves: [], hasHistory: false }
    })

    await useRecommendationsStore().refresh()

    expect(order).toEqual(["playlist", "filters", "build"])
  })

  it("builds against the selected library languages", async () => {
    libraryLanguages.value = ["en", "ru"] as LanguageCode[]

    await useRecommendationsStore().refresh()

    expect(buildRecommendations.mock.calls[0][0].languages).toEqual(["en", "ru"])
    expect(buildRecommendations.mock.calls[0][1]).toEqual({ marker: "repos" })
  })

  it("excludes tracks that are completed or already queued", async () => {
    completedTrackIds.add("t-done")
    hasTrack.mockImplementation((id: TrackId) => id === ("t-queued" as TrackId))

    await useRecommendationsStore().refresh()

    const { isExcluded } = buildRecommendations.mock.calls[0][0]
    expect(isExcluded("t-done" as TrackId)).toBe(true)
    expect(isExcluded("t-queued" as TrackId)).toBe(true)
    expect(isExcluded("t-fresh" as TrackId)).toBe(false)
  })

  it("coalesces overlapping refreshes onto one build", async () => {
    let release: () => void = () => {}
    buildRecommendations.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ recommended: [TRACK], shelves: [], hasHistory: false })
        })
    )
    const s = useRecommendationsStore()

    const first = s.refresh()
    const second = s.refresh()
    expect(s.isLoading).toBe(true)
    await vi.waitFor(() => expect(buildRecommendations).toHaveBeenCalled())
    release()
    await Promise.all([first, second])

    expect(buildRecommendations).toHaveBeenCalledOnce()
    expect(s.recommended).toEqual([TRACK])
  })

  it("runs a fresh build once the previous one has settled", async () => {
    const s = useRecommendationsStore()

    await s.refresh()
    await s.refresh()

    expect(buildRecommendations).toHaveBeenCalledTimes(2)
  })

  it("keeps the previous shelves and stops loading when a build fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const s = useRecommendationsStore()
    await s.refresh()

    buildRecommendations.mockRejectedValue(new Error("catalog missing"))
    await expect(s.refresh()).resolves.toBeUndefined()

    expect(s.recommended).toEqual([TRACK])
    expect(s.isLoading).toBe(false)
  })
})
