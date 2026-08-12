import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { TrackId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const mocks = vi.hoisted(() => ({
  SERVER: { id: "test", urlTemplate: "https://cdn.test/{path}" },
  listReady: vi.fn(),
  getAudioSizesBytes: vi.fn(),
  getById: vi.fn(),
  upsert: vi.fn(),
  resolveLocalUrl: vi.fn(),
  downloadMedia: vi.fn(),
  toastError: vi.fn(),
  toastAction: vi.fn(),
  limitBytes: { value: 0 } as { value: number },
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: { value: mocks.SERVER },
    setActiveServer: vi.fn(),
    mediaDownloader: {
      resolveLocalUrl: mocks.resolveLocalUrl,
      download: vi.fn(async () => "file://local"),
      delete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    },
    repositories: () => ({
      mediaItems: {
        listReady: mocks.listReady,
        upsert: mocks.upsert,
        failStaleDownloads: vi.fn(async () => []),
      },
      tracks: {
        getAudioSizesBytes: mocks.getAudioSizesBytes,
        getById: mocks.getById,
        getTranscriptPath: vi.fn(async () => null),
      },
      transcripts: { get: vi.fn(), listLanguages: vi.fn(async () => []) },
      unitOfWork: { run: vi.fn() },
    }),
    storagePublicUrl: { get: (path: string) => path },
    filesStorage: { delete: vi.fn(async () => {}) },
  }),
}))

vi.mock("@lectorium/composables/useConfig.js", async () => {
  const { ref } = await import("vue")
  mocks.limitBytes = ref(0)
  return { useConfig: () => mocks.limitBytes }
})

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: mocks.toastError, action: mocks.toastAction }),
}))

vi.mock("@usecases/downloads/downloadMedia.js", () => ({ downloadMedia: mocks.downloadMedia }))
vi.mock("@usecases/downloads/removeDownloadedMedia.js", () => ({
  removeDownloadedMedia: vi.fn(),
}))
vi.mock("@usecases/downloads/removeDownloadedTranscripts.js", () => ({
  removeDownloadedTranscripts: vi.fn(),
}))
vi.mock("../downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [mocks.SERVER] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn(async () => {}) }),
}))

import { useDownloadStore } from "../useDownloadStore.js"

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

const MB = 1024 * 1024

const id = (value: string): TrackId => value as TrackId

/** Let the FIFO drain — jobs run one at a time, each awaiting several. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A transfer that never settles, so its row stays `downloading`. */
function hangingDownload(): Promise<never> {
  return new Promise<never>(() => {})
}

function completedDownload(): Promise<unknown> {
  return Promise.resolve({
    ok: true,
    value: { server: mocks.SERVER, mediaItem: { localPath: "file://local" } },
  })
}

function installDefaults(): void {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.resolveLocalUrl.mockResolvedValue(null)
  mocks.upsert.mockResolvedValue(undefined)
  mocks.getById.mockResolvedValue(null)
  mocks.toastError.mockResolvedValue(undefined)
  mocks.toastAction.mockResolvedValue({ kind: "expired" })
  mocks.downloadMedia.mockImplementation(() => completedDownload())
  // 90 MB already spent of a 100 MB budget: nothing 40 MB fits.
  mocks.limitBytes.value = 100 * MB
  mocks.listReady.mockResolvedValue([{ trackId: id("seed") }])
  mocks.getAudioSizesBytes.mockResolvedValue(new Map([[id("seed"), 90 * MB]]))
}

/**
 * `settleUnfundedTail` walks a SNAPSHOT of the prefetch queue with a disk
 * probe (an await) per entry, and the pump can admit one of those entries
 * during the awaits. The walk used to paint the admitted job "deferred"
 * anyway — which also deleted its progress entry, so the row read "waiting
 * for space" with no radial gauge for the whole transfer (#1792).
 */
describe("useDownloadStore unfunded-tail walk", () => {
  beforeEach(installDefaults)

  it("leaves a job admitted during the walk downloading, with its gauge", async () => {
    const store = useDownloadStore()
    // Raising the limit mid-probe is what admits the head: the watcher fires
    // `resumeDeferred`, and the pump starts the very job being walked.
    let raised = false
    mocks.resolveLocalUrl.mockImplementation(async () => {
      if (!raised) {
        raised = true
        mocks.limitBytes.value = 500 * MB
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return null
    })
    mocks.downloadMedia.mockImplementation(() => hangingDownload())

    store.prefetch(id("t1"), "public/t1.mp3", 40 * MB)
    store.prefetch(id("t2"), "public/t2.mp3", 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState(id("t1"))).toBe("downloading")
    expect(store.progress.has(id("t1"))).toBe(true)
    // The rest of the tail is still the walk's, and still unfunded — one
    // slot is busy, so t2 has not started.
    expect(store.getState(id("t2"))).toBe("deferred")
  })

  it("leaves a job admitted before the walk reaches it downloading", async () => {
    const store = useDownloadStore()
    // Here the head completes during the probe, which frees the slot and lets
    // the pump admit the NEXT entry — one the walk has not looked at yet.
    let raised = false
    mocks.resolveLocalUrl.mockImplementation(async () => {
      if (!raised) {
        raised = true
        mocks.limitBytes.value = 500 * MB
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return null
    })
    mocks.downloadMedia.mockImplementation((request: { trackId: TrackId }) =>
      request.trackId === id("t1") ? completedDownload() : hangingDownload()
    )

    store.prefetch(id("t1"), "public/t1.mp3", 40 * MB)
    store.prefetch(id("t2"), "public/t2.mp3", 40 * MB)
    store.prefetch(id("t3"), "public/t3.mp3", 40 * MB)
    await settleQueue()

    expect(store.getState(id("t1"))).toBe("completed")
    expect(store.getState(id("t2"))).toBe("downloading")
    expect(store.progress.has(id("t2"))).toBe(true)
    expect(store.getState(id("t3"))).toBe("deferred")
  })
})
