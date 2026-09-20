import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  // Replaced with a real Vue ref by the useConfig mock factory (which can
  // import "vue"; a hoisted block runs before any import).
  limitBytes: { value: 0 } as { value: number },
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
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

vi.mock("@shruti/composables/useConfig.js", async () => {
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
vi.mock("@shruti/composables/useWantedTranscriptLanguages.js", () => ({
  // The store watches this to backfill transcripts when the user picks up a
  // new language; `ready: false` keeps that watcher out of these tests.
  useWantedTranscriptLanguages: () => ({ languages: { value: [] }, ready: { value: false } }),
}))

import { useDownloadStore } from "../useDownloadStore.js"
import { ESTIMATED_AUDIO_BYTES, useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

const MB = 1024 * 1024

/** Seed `usedBytes` with a single already-downloaded track of `bytes`. */
function seedUsed(bytes: number): void {
  if (bytes <= 0) {
    mocks.listReady.mockResolvedValue([])
    mocks.getAudioSizesBytes.mockResolvedValue(new Map())
    return
  }
  mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
  mocks.getAudioSizesBytes.mockResolvedValue(new Map([["seed" as TrackId, bytes]]))
}

/** One already-downloaded track of `bytes`, as the catalog reports it. */
function seedTrack(trackId: string, bytes: number): void {
  mocks.listReady.mockResolvedValue([{ trackId: trackId as TrackId }])
  mocks.getAudioSizesBytes.mockResolvedValue(new Map([[trackId as TrackId, bytes]]))
}

/** What `evict()` reads: the FIRST language variant carrying audio. */
function catalogAudio(path: string, filesize: number | null): void {
  mocks.getById.mockResolvedValue({ variants: [{ language: "ru", audio: { path, filesize } }] })
}

/** Let the FIFO drain fully — jobs run one at a time, each awaiting several. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function installDefaults(): void {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.resolveLocalUrl.mockResolvedValue(null)
  mocks.upsert.mockResolvedValue(undefined)
  mocks.getById.mockResolvedValue(null)
  mocks.toastError.mockResolvedValue(undefined)
  // Nobody presses "Download anyway" unless a test says so.
  mocks.toastAction.mockResolvedValue({ kind: "expired" })
  mocks.downloadMedia.mockImplementation(async () => ({
    ok: true,
    value: { server: mocks.SERVER, mediaItem: { localPath: "file://local" } },
  }))
  seedUsed(0)
}

// A test that leaves prefetch jobs in flight does not take its state with it.
// The FIFO's continuations call `useDownloadQuotaStore()` when they resume, and
// that resolves against whatever pinia is ACTIVE by then — the next test's. A
// stale 40 MB job landed on the next test's budget, which is why the accounting
// tests saw 70 MB where they had seeded 30. Drain before the pinia is swapped.
afterEach(async () => {
  await settleQueue()
})

describe("useDownloadStore prefetch budget gate", () => {
  beforeEach(installDefaults)

  afterEach(() => {
    mocks.limitBytes.value = 0
  })

  it("downloads a track that exactly fills the remaining budget", async () => {
    mocks.limitBytes.value = 100 * MB
    seedUsed(60 * MB)

    const store = useDownloadStore()
    store.prefetch("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState("t1" as TrackId)).toBe("completed")
    expect(useDownloadQuotaStore().usedBytes).toBe(100 * MB)
  })

  it("defers a track that genuinely exceeds the remaining budget", async () => {
    mocks.limitBytes.value = 100 * MB
    seedUsed(70 * MB)

    const store = useDownloadStore()
    store.prefetch("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    expect(store.getState("t1" as TrackId)).toBe("deferred")
    expect(useDownloadQuotaStore().usedBytes).toBe(70 * MB)
  })

  it("drains a multi-item queue up to — and never past — the limit", async () => {
    mocks.limitBytes.value = 100 * MB
    seedUsed(0)

    const store = useDownloadStore()
    for (const id of ["t1", "t2", "t3", "t4"]) {
      store.prefetch(id as TrackId, `public/${id}.mp3`, 30 * MB)
    }
    await settleQueue()

    const quota = useDownloadQuotaStore()
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(3)
    expect(quota.usedBytes).toBe(90 * MB)
    expect(quota.usedBytes).toBeLessThanOrEqual(mocks.limitBytes.value)
    expect(quota.reservedBytes).toBe(0)
    expect(store.getState("t4" as TrackId)).toBe("deferred")
  })

  it("leaves the reservation map clean after a deferral", async () => {
    mocks.limitBytes.value = 100 * MB
    seedUsed(70 * MB)

    const store = useDownloadStore()
    store.prefetch("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(useDownloadQuotaStore().reservedBytes).toBe(0)
  })

  /* ----------------------------- issue #1487 ---------------------------- */

  it("lets a pressed “Download anyway” overshoot the limit — once", async () => {
    mocks.limitBytes.value = 100 * MB
    seedUsed(90 * MB)
    mocks.toastAction.mockResolvedValue({ kind: "pressed", index: 0 })

    const store = useDownloadStore()
    await store.ensureDownloaded("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    const quota = useDownloadQuotaStore()
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState("t1" as TrackId)).toBe("completed")
    expect(quota.usedBytes).toBe(130 * MB)
    // The exception is spent on those bytes and nothing else: the configured
    // limit is exactly what the user left in Settings, and the next track is
    // measured against it — now with the overshoot counted in.
    expect(mocks.limitBytes.value).toBe(100 * MB)
    expect(quota.limitBytes).toBe(100 * MB)
    expect(quota.hasRoomFor(1 * MB)).toBe(false)

    mocks.toastAction.mockResolvedValue({ kind: "expired" })
    store.prefetch("t2" as TrackId, "public/t2.mp3", 1 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState("t2" as TrackId)).toBe("deferred")
  })

  it("says nothing at all when the draining queue hits the wall", async () => {
    // A notice belongs to an interaction. The queue hitting a limit it was
    // always going to hit is not news — and a library already at the cap was
    // getting this toast on every single launch (#1578). The rows carry the
    // state instead.
    mocks.limitBytes.value = 100 * MB
    seedUsed(90 * MB)

    const store = useDownloadStore()
    for (const id of ["t1", "t2"]) store.prefetch(id as TrackId, `public/${id}.mp3`, 40 * MB)
    await settleQueue()
    for (const id of ["t3", "t4"]) store.prefetch(id as TrackId, `public/${id}.mp3`, 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastAction).not.toHaveBeenCalled()
    expect(store.getState("t1" as TrackId)).toBe("deferred")
  })
})

/* --------------------------------------------------------------------- */
/*                    issue #1613 — the budget ratchet                   */
/* --------------------------------------------------------------------- */

/**
 * Every one of these charged the budget more than it credited, so the cap
 * refused earlier and earlier the longer a session ran — and only a Settings
 * visit (which re-measures from scratch) put it right.
 */
describe("useDownloadStore budget accounting", () => {
  beforeEach(installDefaults)

  afterEach(() => {
    mocks.limitBytes.value = 0
  })

  it("charges a re-downloaded track once, not twice", async () => {
    mocks.limitBytes.value = 200 * MB
    seedTrack("t1", 30 * MB)

    const store = useDownloadStore()
    await store.hydrate()
    const quota = useDownloadQuotaStore()
    expect(quota.usedBytes).toBe(30 * MB)

    // The native cache no longer has the file, so the "ready" row is demoted
    // and the bytes are fetched again. They are the same bytes: the track
    // must end up costing what it costs, not double.
    await store.ensureDownloaded("t1" as TrackId, "public/t1.mp3", 30 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(quota.usedBytes).toBe(30 * MB)
  })

  it("frees the demoted row's bytes before the budget gate runs", async () => {
    // Same probe miss, but with the budget nearly spent: the stale charge for
    // a file that is provably not on disk must not be what refuses its own
    // re-download.
    mocks.limitBytes.value = 100 * MB
    seedTrack("t1", 90 * MB)

    const store = useDownloadStore()
    await store.hydrate()
    await store.ensureDownloaded("t1" as TrackId, "public/t1.mp3", 90 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(mocks.toastAction).not.toHaveBeenCalled()
    expect(useDownloadQuotaStore().usedBytes).toBe(90 * MB)
  })

  it("credits back what an estimated track was charged, not the catalog size", async () => {
    // The Home retry entry point used to omit the size, so the track paid the
    // corpus-average estimate while the eviction handed back the real 12 MB —
    // the difference leaked out of the budget for the rest of the session.
    mocks.limitBytes.value = 200 * MB

    const store = useDownloadStore()
    await store.ensureDownloaded("t1" as TrackId, "public/t1.mp3")
    await settleQueue()

    const quota = useDownloadQuotaStore()
    expect(quota.usedBytes).toBe(ESTIMATED_AUDIO_BYTES)

    catalogAudio("public/t1.mp3", 12 * MB)
    expect(await store.evict("t1" as TrackId)).toBe(true)
    expect(quota.usedBytes).toBe(0)
  })

  it("credits the measured size, not the first variant's", async () => {
    // `refresh()` charges the LARGEST language variant; `evict()` used to read
    // the FIRST one. Two sources of truth for one number, and the gap stayed
    // charged to a track that is no longer on disk.
    mocks.limitBytes.value = 200 * MB
    seedTrack("t1", 50 * MB)

    const store = useDownloadStore()
    await store.hydrate()
    expect(useDownloadQuotaStore().usedBytes).toBe(50 * MB)

    catalogAudio("public/t1.mp3", 12 * MB)
    expect(await store.evict("t1" as TrackId)).toBe(true)
    expect(useDownloadQuotaStore().usedBytes).toBe(0)
  })

  it("does not credit a track that was never charged", async () => {
    // Archiving a lecture that was never downloaded must not invent budget.
    mocks.limitBytes.value = 200 * MB
    seedTrack("t1", 50 * MB)

    const store = useDownloadStore()
    await store.hydrate()
    catalogAudio("public/t2.mp3", 12 * MB)

    expect(await store.evict("t2" as TrackId)).toBe(false)
    expect(useDownloadQuotaStore().usedBytes).toBe(50 * MB)
  })
})

/**
 * The one way found to start a transfer the budget should have refused, with
 * nobody pressing anything: a measurement that failed leaves `usedBytes` at a
 * placeholder 0, and a placeholder 0 reads as an empty disk.
 */
describe("useDownloadStore gate with an unmeasurable budget", () => {
  beforeEach(installDefaults)

  afterEach(() => {
    mocks.limitBytes.value = 0
  })

  it("starts nothing while the budget cannot be measured", async () => {
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockRejectedValue(new Error("content db not open"))

    const store = useDownloadStore()
    store.prefetch("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    expect(store.getState("t1" as TrackId)).toBe("deferred")
  })

  it("does not claim storage is full when the budget is simply unknown", async () => {
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockRejectedValue(new Error("content db not open"))

    const store = useDownloadStore()
    await store.ensureDownloaded("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()

    expect(mocks.downloadMedia).not.toHaveBeenCalled()
    expect(mocks.toastAction).not.toHaveBeenCalled()
  })

  it("drains the tail it held once a measurement lands", async () => {
    mocks.limitBytes.value = 100 * MB
    mocks.listReady.mockResolvedValue([{ trackId: "seed" as TrackId }])
    mocks.getAudioSizesBytes.mockRejectedValue(new Error("content db not open"))

    const store = useDownloadStore()
    store.prefetch("t1" as TrackId, "public/t1.mp3", 40 * MB)
    await settleQueue()
    expect(mocks.downloadMedia).not.toHaveBeenCalled()

    // Whatever was wrong with the DB is over. Nothing else re-triggers the
    // queue — no eviction, no limit change — so the measurement itself has to.
    mocks.getAudioSizesBytes.mockResolvedValue(new Map([["seed" as TrackId, 30 * MB]]))
    await useDownloadQuotaStore().refresh()
    await settleQueue()

    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.getState("t1" as TrackId)).toBe("completed")
    expect(useDownloadQuotaStore().usedBytes).toBe(70 * MB)
  })
})
