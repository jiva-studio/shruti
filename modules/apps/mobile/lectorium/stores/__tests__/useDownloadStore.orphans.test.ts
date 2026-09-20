import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { TrackId } from "@lib/domain/core.js"
import type { AudioQueueState } from "@ports/app/audioPlayer.js"

/**
 * Orphan collection for downloaded audio (issue #1666).
 *
 * A lecture archived while the native engine could still reach its file has
 * its eviction held back. That debt used to live only in a `Set` at module
 * scope in the player: kill the app inside the window and the record went
 * with the process, while the `media_items` row stayed "ready" — so
 * `usedBytes` kept charging the user for a file nothing pointed at, and the
 * budget refused new downloads for space nobody was using. Nothing else in
 * the app collects orphans, so there was no second chance.
 */

const mocks = vi.hoisted(() => ({
  SERVER: { id: "test", urlTemplate: "https://cdn.test/{path}" },
  listReady: vi.fn(),
  listEvictPending: vi.fn(),
  markEvictPending: vi.fn(),
  getAudioSizesBytes: vi.fn(),
  getById: vi.fn(),
  getQueueState: vi.fn(),
  deleteLocal: vi.fn(),
  removeDownloadedMedia: vi.fn(),
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: { value: mocks.SERVER },
    setActiveServer: vi.fn(),
    audioPlayer: { getQueueState: mocks.getQueueState },
    mediaDownloader: {
      resolveLocalUrl: vi.fn(async () => null),
      download: vi.fn(async () => "file://local"),
      delete: mocks.deleteLocal,
      cancel: vi.fn(async () => {}),
    },
    repositories: () => ({
      mediaItems: {
        listReady: mocks.listReady,
        listEvictPending: mocks.listEvictPending,
        markEvictPending: mocks.markEvictPending,
        upsert: vi.fn(async () => ({})),
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
  return { useConfig: () => ref(0) }
})
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), action: vi.fn() }),
}))
vi.mock("@usecases/downloads/downloadMedia.js", () => ({ downloadMedia: vi.fn() }))
vi.mock("@usecases/downloads/removeDownloadedMedia.js", () => ({
  removeDownloadedMedia: mocks.removeDownloadedMedia,
}))
vi.mock("@usecases/downloads/removeDownloadedTranscripts.js", () => ({
  removeDownloadedTranscripts: vi.fn(async () => {}),
}))
vi.mock("../downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [mocks.SERVER] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn(async () => {}) }),
}))
vi.mock("@lectorium/composables/useWantedTranscriptLanguages.js", () => ({
  // The store watches this to backfill transcripts when the user picks up a
  // new language; `ready: false` keeps that watcher out of these tests.
  useWantedTranscriptLanguages: () => ({ languages: { value: [] }, ready: { value: false } }),
}))

import { useDownloadStore } from "../useDownloadStore.js"
import { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

const MB = 1024 * 1024
const OWED = "t-owed" as TrackId
const KEPT = "t-kept" as TrackId

function noQueue(): AudioQueueState {
  return {
    currentItemId: null,
    positionMs: 0,
    durationMs: 0,
    playing: false,
    queueCount: 0,
    events: [],
  }
}

/** Let the un-awaited sweep `hydrate` kicks off run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useDownloadStore — orphan collection", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.markEvictPending.mockResolvedValue(undefined)
    // Both lectures are on disk and charged to the budget; only one of them is
    // owed an eviction the previous session never got to perform.
    mocks.listReady.mockResolvedValue([{ trackId: OWED }, { trackId: KEPT }])
    mocks.getAudioSizesBytes.mockResolvedValue(
      new Map([
        [OWED, 30 * MB],
        [KEPT, 30 * MB],
      ])
    )
    mocks.getById.mockResolvedValue({
      variants: [{ language: "en", audio: { path: "public/a.mp3", filesize: 30 * MB } }],
    })
    mocks.listEvictPending.mockResolvedValue([{ trackId: OWED, state: "ready" }])
    mocks.getQueueState.mockResolvedValue(noQueue())
    mocks.removeDownloadedMedia.mockResolvedValue({ ok: true, value: undefined })
  })

  it("reclaims a file the previous session was killed still owing", async () => {
    const downloads = useDownloadStore()
    const quota = useDownloadQuotaStore()

    await downloads.hydrate()
    await settle()

    // The debt survived the process that incurred it, and the sweep settles it.
    expect(mocks.removeDownloadedMedia).toHaveBeenCalledTimes(1)
    expect(mocks.removeDownloadedMedia.mock.calls[0]?.[0]).toMatchObject({ trackId: OWED })
    // …which is the point: the budget stops charging for it. Without the
    // collector both lectures stay charged forever and the cap creeps down.
    expect(quota.usedBytes).toBe(30 * MB)
    expect(downloads.getState(KEPT)).toBe("completed")
  })

  it("leaves the debt for the player while the engine still holds a queue", async () => {
    // A queue restored from a previous session still carries `file://` URLs.
    // Deleting one out from under it is the failure the player defers to; it
    // can see the queue, this cannot.
    mocks.getQueueState.mockResolvedValue({ ...noQueue(), currentItemId: "i-1" })

    await useDownloadStore().hydrate()
    await settle()

    expect(mocks.removeDownloadedMedia).not.toHaveBeenCalled()
    // Postponed, not lost — the row still carries the flag for the next launch.
    expect(mocks.listEvictPending).toHaveBeenCalled()
  })

  it("does nothing when nothing is owed", async () => {
    mocks.listEvictPending.mockResolvedValue([])

    await useDownloadStore().hydrate()
    await settle()

    expect(mocks.removeDownloadedMedia).not.toHaveBeenCalled()
    // Not even a bridge call to the engine: the common launch stays free.
    expect(mocks.getQueueState).not.toHaveBeenCalled()
  })

  it("records a debt against the media row", async () => {
    const downloads = useDownloadStore()

    await downloads.markEvictPending(OWED)

    expect(mocks.markEvictPending).toHaveBeenCalledWith(OWED)
  })
})
