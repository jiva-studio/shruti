import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                          Module-level mocks                           */
/* --------------------------------------------------------------------- */

const availableLanguages = vi.fn<(trackId: TrackId) => Promise<readonly LanguageCode[]>>()
const get = vi.fn<(trackId: TrackId, language: LanguageCode) => Promise<unknown>>()
const listReady = vi.fn<() => Promise<readonly { trackId: TrackId }[]>>()

const libraryLanguages = ref<readonly LanguageCode[]>([])
const filtersLoaded = ref(true)

vi.mock("@shruti/composables/useWantedTranscriptLanguages.js", () => ({
  useWantedTranscriptLanguages: () => ({
    languages: computed(() => libraryLanguages.value),
    ready: computed(() => filtersLoaded.value),
  }),
}))
vi.mock("../useServerFallback.js", () => ({
  useServerFallback: () => ({
    // The real one rotates CDNs; here it just runs the call and maps a
    // rejection to `null`, which is the contract `prefetchForTrack` reads.
    tryServers: async (run: () => Promise<unknown>) => run().catch(() => null),
  }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      transcripts: { availableLanguages, get, has: vi.fn() },
      mediaItems: { listReady },
    }),
  }),
}))

const { useTranscriptPrefetch } = await import("../useTranscriptPrefetch.js")

const TRACK = "t-1" as TrackId

/** Languages `prefetchForTrack` actually pulled, in call order. */
function fetched(): string[] {
  return get.mock.calls.map(([, language]) => language)
}

describe("useTranscriptPrefetch", () => {
  beforeEach(() => {
    availableLanguages.mockReset().mockResolvedValue(["en", "ru", "es"] as readonly LanguageCode[])
    get.mockReset().mockResolvedValue({ blocks: [] })
    listReady.mockReset().mockResolvedValue([])
    libraryLanguages.value = []
    filtersLoaded.value = true
  })

  it("downloads only the languages the user reads, not every advertised one", async () => {
    libraryLanguages.value = ["ru", "en"] as readonly LanguageCode[]

    await useTranscriptPrefetch().prefetchForTrack(TRACK)

    expect(fetched()).toEqual(["en", "ru"])
    expect(fetched()).not.toContain("es")
  })

  it("keeps the source language when the user reads none of the advertised ones", async () => {
    // A Spanish-only lecture saved by a ru/en reader: the dialog opens on the
    // language it was recorded in, so that one still has to be on disk.
    availableLanguages.mockResolvedValue(["es", "pt"] as readonly LanguageCode[])
    libraryLanguages.value = ["ru", "en"] as readonly LanguageCode[]

    await useTranscriptPrefetch().prefetchForTrack(TRACK)

    expect(fetched()).toEqual(["es"])
  })

  it("falls back to every advertised language while the selection is unknown", async () => {
    // Before the persisted selection is read back, the wanted set is a guess.
    // Narrowing on a guess would silently skip a language the user does read.
    filtersLoaded.value = false
    libraryLanguages.value = ["en"] as readonly LanguageCode[]

    await useTranscriptPrefetch().prefetchForTrack(TRACK)

    expect(fetched()).toEqual(["en", "ru", "es"])
  })

  it("backfills saved lectures with a language chosen after they were downloaded", async () => {
    listReady.mockResolvedValue([{ trackId: "t-1" as TrackId }, { trackId: "t-2" as TrackId }])
    libraryLanguages.value = ["en"] as readonly LanguageCode[]
    const prefetch = useTranscriptPrefetch()
    await prefetch.prefetchForTrack(TRACK)
    expect(fetched()).toEqual(["en"])
    get.mockClear()

    libraryLanguages.value = ["en", "ru"] as readonly LanguageCode[]
    await prefetch.backfillDownloaded()

    expect(get.mock.calls).toEqual([
      ["t-1", "en"],
      ["t-1", "ru"],
      ["t-2", "en"],
      ["t-2", "ru"],
    ])
  })

  it("does not crash the backfill when the saved-track list is unreadable", async () => {
    listReady.mockRejectedValue(new Error("db locked"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(useTranscriptPrefetch().backfillDownloaded()).resolves.toBeUndefined()

    expect(get).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
