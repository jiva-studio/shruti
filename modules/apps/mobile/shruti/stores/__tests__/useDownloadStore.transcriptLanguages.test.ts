import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { nextTick, ref } from "vue"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const backfillDownloaded = vi.fn(async () => {})
const wantedLanguages = ref<readonly string[]>([])
const wantedReady = ref(false)

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), action: vi.fn() }),
}))
vi.mock("@usecases/downloads/downloadMedia.js", () => ({ downloadMedia: vi.fn() }))
vi.mock("@usecases/downloads/removeDownloadedMedia.js", () => ({
  removeDownloadedMedia: vi.fn(),
}))
vi.mock("@usecases/downloads/removeDownloadedTranscripts.js", () => ({
  removeDownloadedTranscripts: vi.fn(),
}))
vi.mock("../downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn(async () => {}), backfillDownloaded }),
}))
vi.mock("@shruti/composables/useWantedTranscriptLanguages.js", () => ({
  useWantedTranscriptLanguages: () => ({ languages: wantedLanguages, ready: wantedReady }),
}))
vi.mock("../useDownloadQuotaStore.js", () => ({
  useDownloadQuotaStore: () => ({ refresh: () => Promise.resolve(), reset: vi.fn() }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: { value: { id: "global" } },
    setActiveServer: vi.fn(),
    mediaDownloader: { resolveLocalUrl: vi.fn(), download: vi.fn(), cancel: vi.fn() },
    repositories: () => ({
      mediaItems: { upsert: vi.fn(), failStaleDownloads: vi.fn(), listReady: vi.fn() },
      unitOfWork: {},
    }),
  }),
}))

import { useDownloadStore } from "../useDownloadStore.js"

/** Move the wanted set and let the store's watcher run. */
async function choose(languages: readonly string[]): Promise<void> {
  wantedLanguages.value = languages
  await nextTick()
}

describe("useDownloadStore — transcripts follow the language selection", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    backfillDownloaded.mockClear()
    wantedLanguages.value = ["en"]
    wantedReady.value = false
  })

  it("backfills saved lectures when a language is added later", async () => {
    useDownloadStore()
    wantedReady.value = true
    await nextTick()

    await choose(["en", "ru"])

    expect(backfillDownloaded).toHaveBeenCalledTimes(1)
  })

  it("does not backfill when the persisted selection merely arrives", async () => {
    // The set starts as a guess from the UI locale and is replaced by the
    // user's own once preferences are read back — nobody chose anything.
    useDownloadStore()

    wantedReady.value = true
    wantedLanguages.value = ["ru", "en"]
    await nextTick()

    expect(backfillDownloaded).not.toHaveBeenCalled()
  })

  it("does not backfill when a language is removed", async () => {
    useDownloadStore()
    wantedReady.value = true
    await choose(["en", "ru"])
    backfillDownloaded.mockClear()

    await choose(["en"])

    expect(backfillDownloaded).not.toHaveBeenCalled()
  })
})
