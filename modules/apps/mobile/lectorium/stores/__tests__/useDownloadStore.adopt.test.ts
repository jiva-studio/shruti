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
  upsert: vi.fn(),
  resolveLocalUrl: vi.fn(),
  deleteFile: vi.fn(),
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
      delete: mocks.deleteFile,
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
        getById: vi.fn(async () => null),
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

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
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
vi.mock("@lectorium/composables/useWantedTranscriptLanguages.js", () => ({
  // The store watches this to backfill transcripts when the user picks up a
  // new language; `ready: false` keeps that watcher out of these tests.
  useWantedTranscriptLanguages: () => ({ languages: { value: [] }, ready: { value: false } }),
}))

import { useDownloadStore } from "../useDownloadStore.js"
import { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

const MB = 1024 * 1024
const T1 = "t1" as TrackId
const ON_DISK = "file:///data/lectorium/t1.mp3"

const DELIVERED = {
  ok: true,
  value: { server: mocks.SERVER, mediaItem: { localPath: "file://local" } },
}

/** Let the FIFO drain fully — jobs run one at a time, each awaiting several. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.limitBytes.value = 0
  mocks.listReady.mockResolvedValue([])
  mocks.getAudioSizesBytes.mockResolvedValue(new Map())
  mocks.upsert.mockResolvedValue(undefined)
  mocks.toastError.mockResolvedValue(undefined)
  mocks.toastAction.mockResolvedValue({ kind: "expired" })
  mocks.resolveLocalUrl.mockResolvedValue(null)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.downloadMedia.mockResolvedValue(DELIVERED)
})

/* --------------------------------------------------------------------- */
/*                             issue #1739                                */
/* --------------------------------------------------------------------- */

/**
 * Sharing a lecture downloads the full audio through the same adapter and the
 * same key as an offline save, so the cache-hit branch is reachable with no
 * `media_items` row behind it. It used to paint the row "completed" and return
 * — writing nothing and charging nothing — which left the badge to vanish on
 * the next launch (`hydrate()` rebuilds from `listReady()`), the budget short
 * by the size of everything shared, and `evict()` refusing to reclaim a file
 * that then survived until uninstall.
 */
describe("useDownloadStore — a file the cache already holds", () => {
  it("writes the media row and charges the budget for it", async () => {
    mocks.limitBytes.value = 200 * MB
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    expect(await store.ensureDownloaded(T1, "public/t1.mp3", 30 * MB)).toBe(ON_DISK)

    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    expect(mocks.upsert).toHaveBeenCalledWith(T1, "ready", ON_DISK)
    expect(useDownloadQuotaStore().usedBytes).toBe(30 * MB)
    expect(store.getState(T1)).toBe("completed")
  })

  it("survives the relaunch that rebuilds from the database", async () => {
    mocks.limitBytes.value = 200 * MB
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.ensureDownloaded(T1, "public/t1.mp3", 30 * MB)

    // What the next launch reads back. The row the adoption wrote is what puts
    // the track in `listReady()` — without it the badge is gone and `evict()`
    // bails before it can reclaim anything.
    const [trackId, state, localPath] = mocks.upsert.mock.calls.at(-1)!
    expect({ trackId, state, localPath }).toEqual({
      trackId: T1,
      state: "ready",
      localPath: ON_DISK,
    })
  })

  it("keeps the catalog's measured size rather than re-charging an estimate", async () => {
    // The track is already counted from a measurement that read the catalog.
    // Adopting must not overwrite that with the caller's cruder number.
    mocks.limitBytes.value = 200 * MB
    mocks.listReady.mockResolvedValue([{ trackId: T1 }])
    mocks.getAudioSizesBytes.mockResolvedValue(new Map([[T1, 12 * MB]]))
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.hydrate()
    await store.ensureDownloaded(T1, "public/t1.mp3")

    expect(useDownloadQuotaStore().usedBytes).toBe(12 * MB)
  })
})

/* --------------------------------------------------------------------- */
/*                             issue #1744                                */
/* --------------------------------------------------------------------- */

/**
 * The download state is derived from `media_items` plus budget arithmetic, and
 * nothing on the path that refuses a track for space ever asks the disk — the
 * drain paints the whole waiting tail before `ensureDownloaded` (and its cache
 * probe) is reached at all. So a lecture that IS saved was reported as not
 * downloaded and held back for space, while the player resolved the same file
 * and played it offline.
 */
describe("useDownloadStore — the budget decision consults the disk", () => {
  it("does not hold back a lecture the disk already has", async () => {
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockResolvedValue(new Map([["seed" as TrackId, 90 * MB]]))
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.hydrate()
    store.prefetch(T1, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(store.getState(T1)).toBe("completed")
    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    // Nothing was refused, so nothing is claimed to be full.
    expect(mocks.toastAction).not.toHaveBeenCalled()
    // And the bytes stop being invisible: the meter counts what is on disk.
    expect(useDownloadQuotaStore().usedBytes).toBe(130 * MB)
  })

  it("still defers a lecture the disk does not have", async () => {
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockResolvedValue(new Map([["seed" as TrackId, 90 * MB]]))

    const store = useDownloadStore()
    await store.hydrate()
    store.prefetch(T1, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(store.getState(T1)).toBe("deferred")
    expect(mocks.downloadMedia).not.toHaveBeenCalled()
  })

  /* --------------------------- the retry path -------------------------- */

  /**
   * The reported chain, end to end. A transfer runs in an iOS background
   * `URLSession`, which goes on delivering while the app is suspended or
   * killed; the file lands while the row still says "downloading". The next
   * launch calls `failStaleDownloads()`, which is an unconditional
   * `UPDATE … SET state='failed', local_path=NULL WHERE state='downloading'`
   * — it never asks whether the bytes arrived. From then on `effectiveState`
   * reads "failed", `isRetryAfterFailure` is true, and the cache probe was
   * skipped entirely, so every tap walked into the budget gate knowing nothing
   * about the disk. Over budget, that is a "storage is full" popup over a
   * lecture the player is happily playing offline.
   *
   * The skip itself is right — a failed attempt can leave a BAD file, which on
   * iOS is a CDN error page written to the lecture's own path (#1722) — but it
   * answers the wrong question. "Is there a file" belongs to the budget; "is
   * that file any good" belongs to the retry.
   *
   * This is the consumer end. The demotion that starts the chain is now
   * reconciled against the disk at launch (#1755, see
   * `useDownloadStore.stale.test.ts`), so the row itself stops lying — but the
   * budget must hold the line on its own regardless, since a row can be wrong
   * for reasons no reconciliation covers.
   */
  it("does not claim storage is full for a retry whose bytes are on disk", async () => {
    mocks.limitBytes.value = 200 * MB
    mocks.downloadMedia.mockResolvedValue({ ok: false, error: "transfer-failed" })

    const store = useDownloadStore()
    await store.ensureDownloaded(T1, "public/t1.mp3", 40 * MB)
    mocks.downloadMedia.mockResolvedValue(DELIVERED)
    expect(store.getState(T1)).toBe("failed")

    // The background session delivered after all, and the launch that found
    // the row still "downloading" blanked it anyway. Meanwhile the budget has
    // filled up.
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)
    mocks.limitBytes.value = 1 * MB

    await store.ensureDownloaded(T1, "public/t1.mp3", 40 * MB, "user")

    expect(mocks.toastAction).not.toHaveBeenCalled()
    expect(store.getState(T1)).not.toBe("deferred")
  })

  it("still re-fetches that retry rather than trusting the file", async () => {
    // The other half of the split: the budget stops refusing, but the retry
    // must not start serving a file whose last attempt failed — it evicts the
    // native entry and downloads again, exactly as before.
    mocks.limitBytes.value = 200 * MB
    mocks.downloadMedia.mockResolvedValue({ ok: false, error: "transfer-failed" })

    const store = useDownloadStore()
    await store.ensureDownloaded(T1, "public/t1.mp3", 40 * MB)
    mocks.downloadMedia.mockResolvedValue(DELIVERED)
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)
    mocks.limitBytes.value = 1 * MB

    expect(await store.ensureDownloaded(T1, "public/t1.mp3", 40 * MB, "user")).toBe("file://local")
    expect(mocks.deleteFile).toHaveBeenCalledWith("https://cdn.test/public/t1.mp3")
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(2)
  })

  it("does not adopt a failed row's leftovers into the queue's tail", async () => {
    // Same distrust, from the drain side: a file left behind by a failed
    // attempt must not be quietly promoted to "downloaded" — that is how a CDN
    // error page written to the lecture's path becomes permanent (#1722).
    mocks.limitBytes.value = 200 * MB
    mocks.downloadMedia.mockResolvedValue({ ok: false, error: "transfer-failed" })

    const store = useDownloadStore()
    await store.ensureDownloaded(T1, "public/t1.mp3", 40 * MB)
    mocks.downloadMedia.mockResolvedValue(DELIVERED)
    expect(store.getState(T1)).toBe("failed")

    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)
    mocks.limitBytes.value = 1 * MB
    store.prefetch(T1, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(store.getState(T1)).toBe("failed")
  })

  it("asks the disk once per lecture, not once per drain", async () => {
    // `resolveLocalUrl` is a native round trip and the FIFO re-drains on every
    // eviction and every limit change, so an un-memoised probe would cost one
    // bridge call per queued lecture per drain.
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockResolvedValue(new Map([["seed" as TrackId, 90 * MB]]))

    const store = useDownloadStore()
    await store.hydrate()
    store.prefetch(T1, "public/t1.mp3", 40 * MB)
    await settleQueue()
    const afterFirstDrain = mocks.resolveLocalUrl.mock.calls.length
    expect(afterFirstDrain).toBeGreaterThan(0)

    store.resumeDeferred()
    store.resumeDeferred()
    await settleQueue()

    expect(mocks.resolveLocalUrl.mock.calls.length).toBe(afterFirstDrain)
  })
})
