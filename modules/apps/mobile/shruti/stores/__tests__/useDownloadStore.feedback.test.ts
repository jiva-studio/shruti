import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { watch } from "vue"
import type { DownloadState } from "../useDownloadStore.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>()
const deleteFile = vi.fn<(url: string) => Promise<void>>()
const upsert = vi.fn<(id: string, state: string, path: string | null) => Promise<void>>()
const downloadMedia = vi.fn()
const toastError = vi.fn()
const prefetchForTrack = vi.fn()

let hasRoom = true
const reserve = vi.fn()
const settle = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, success: vi.fn() }),
}))
vi.mock("@lib/domain/servers.js", () => ({
  buildServerUrl: (_server: unknown, path: string) => `https://cdn.test/${path}`,
}))
vi.mock("@usecases/downloads/downloadMedia.js", () => ({
  downloadMedia: (...args: unknown[]) => downloadMedia(...args),
}))
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
  useTranscriptPrefetch: () => ({ prefetchForTrack }),
}))
vi.mock("../useDownloadQuotaStore.js", () => ({
  useDownloadQuotaStore: () => ({
    limitBytes: 0,
    ensureMeasured: () => Promise.resolve(),
    sizeOf: () => 1000,
    hasRoomFor: () => hasRoom,
    reserve,
    settle,
    forget: vi.fn(),
    refresh: () => Promise.resolve(),
    reset: vi.fn(),
  }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: { value: { id: "global" } },
    setActiveServer: vi.fn(),
    mediaDownloader: {
      resolveLocalUrl,
      delete: deleteFile,
      download: vi.fn(),
      cancel: vi.fn(() => Promise.resolve()),
    },
    repositories: () => ({
      mediaItems: { upsert, failStaleDownloads: vi.fn(), listReady: vi.fn() },
      unitOfWork: {},
    }),
  }),
}))

import { useDownloadStore } from "../useDownloadStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const TRACK = "track-1"
const PATH = "public/audio/track-1.mp3"

type Store = ReturnType<typeof useDownloadStore>

/** Record every state this track is painted with, in order. */
function trackStates(store: Store): DownloadState[] {
  const seen: DownloadState[] = []
  watch(
    () => store.states.get(TRACK),
    (state) => {
      if (state) seen.push(state)
    },
    { flush: "sync" }
  )
  return seen
}

function online(value: boolean): void {
  vi.stubGlobal("navigator", { onLine: value })
}

describe("useDownloadStore — tap feedback and failure notices", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    hasRoom = true
    online(true)
    resolveLocalUrl.mockResolvedValue(null)
    deleteFile.mockResolvedValue(undefined)
    upsert.mockResolvedValue(undefined)
    downloadMedia.mockResolvedValue({
      ok: true,
      value: {
        server: { id: "global" },
        mediaItem: { localPath: "file:///local/track-1.mp3" },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /* ----------------------------- issue #1483 ---------------------------- */

  it("claims `pending` synchronously, before the first await settles", async () => {
    // Hold the cache probe open: the row must already read "pending" while
    // the very first await of the task is still unresolved.
    let releaseProbe: (value: string | null) => void = () => {}
    resolveLocalUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseProbe = resolve
      })
    )
    const store = useDownloadStore()

    const task = store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("pending")
    await Promise.resolve()
    expect(store.getState(TRACK)).toBe("pending")

    releaseProbe("file:///local/track-1.mp3")
    await task
    expect(store.getState(TRACK)).toBe("completed")
  })

  it("never paints `downloading` for a track the storage budget refuses", async () => {
    hasRoom = false
    const store = useDownloadStore()
    const seen = trackStates(store)

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(seen).toEqual(["pending", "deferred"])
    expect(seen).not.toContain("downloading")
    // Nothing was written to disk or to the media row on the way to the gate.
    expect(upsert).not.toHaveBeenCalled()
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it("clears `pending` when the transfer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    downloadMedia.mockRejectedValue(new Error("boom"))
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(store.getState(TRACK)).toBe("failed")
  })

  it("leaves no `pending` behind on any exit path", async () => {
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)
    expect(store.getState(TRACK)).toBe("completed")

    // Cache hit.
    resolveLocalUrl.mockResolvedValue("file:///local/other.mp3")
    await store.ensureDownloaded("track-2", "public/audio/track-2.mp3")
    expect(store.getState("track-2")).toBe("completed")

    // Budget refusal.
    resolveLocalUrl.mockResolvedValue(null)
    hasRoom = false
    await store.ensureDownloaded("track-3", "public/audio/track-3.mp3")
    expect(store.getState("track-3")).toBe("deferred")
  })

  it("clearPending drops a claim that never resolved, and spares a real state", () => {
    const store = useDownloadStore()

    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("pending")
    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("idle")

    store.markStartingDownload(TRACK)
    store.clearPending(TRACK)
    expect(store.getState(TRACK)).toBe("downloading")
  })

  it("preserves a terminal state instead of rewinding it to `pending`", () => {
    const store = useDownloadStore()

    store.markPending(TRACK)
    store.markStartingDownload(TRACK)
    store.markPending(TRACK)
    expect(store.getState(TRACK)).toBe("downloading")
  })

  /* ----------------------------- issue #1484 ---------------------------- */

  it("tells the user when there is no connectivity", async () => {
    online(false)
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(store.getState(TRACK)).toBe("failed")
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("tells the user when every CDN candidate is exhausted", async () => {
    downloadMedia.mockResolvedValue({ ok: false, error: "all-candidates-failed" })
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(store.getState(TRACK)).toBe("failed")
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("tells the user when the transfer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    downloadMedia.mockRejectedValue(new Error("boom"))
    const store = useDownloadStore()

    const url = await store.ensureDownloaded(TRACK, PATH)

    expect(url).toBeNull()
    expect(toastError).toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("says storage-is-full — NOT a connectivity failure — on the budget gate", async () => {
    hasRoom = false
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(toastError).toHaveBeenCalledWith("errors.downloadStorageFull")
    expect(toastError).not.toHaveBeenCalledWith("errors.downloadFailed")
  })

  it("stays quiet on success", async () => {
    const store = useDownloadStore()

    await store.ensureDownloaded(TRACK, PATH)

    expect(toastError).not.toHaveBeenCalled()
  })
})
