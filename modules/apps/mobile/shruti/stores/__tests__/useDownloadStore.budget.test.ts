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
        failStaleDownloads: vi.fn(async () => {}),
      },
      tracks: { getAudioSizesBytes: mocks.getAudioSizesBytes },
      unitOfWork: { run: vi.fn() },
    }),
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

import { useDownloadStore } from "../useDownloadStore.js"
import { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

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

/** Let the FIFO drain fully — jobs run one at a time, each awaiting several. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useDownloadStore prefetch budget gate", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.resolveLocalUrl.mockResolvedValue(null)
    mocks.upsert.mockResolvedValue(undefined)
    mocks.toastError.mockResolvedValue(undefined)
    // Nobody presses "Download anyway" unless a test says so.
    mocks.toastAction.mockResolvedValue({ kind: "expired" })
    mocks.downloadMedia.mockImplementation(async () => ({
      ok: true,
      value: { server: mocks.SERVER, mediaItem: { localPath: "file://local" } },
    }))
    seedUsed(0)
  })

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
