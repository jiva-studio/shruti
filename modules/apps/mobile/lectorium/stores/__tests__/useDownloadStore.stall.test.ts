import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { TrackId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>()
const download = vi.fn()
const cancel = vi.fn<(url: string) => Promise<void>>()
const upsert = vi.fn()
const downloadMedia = vi.fn()
const toastError = vi.fn()
const toastAction = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), action: toastAction }),
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
  useServerFallback: () => ({ candidates: () => [{ id: "global" }] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn() }),
}))
vi.mock("@lectorium/composables/useWantedTranscriptLanguages.js", () => ({
  // The store watches this to backfill transcripts when the user picks up a
  // new language; `ready: false` keeps that watcher out of these tests.
  useWantedTranscriptLanguages: () => ({ languages: { value: [] }, ready: { value: false } }),
}))
vi.mock("../useDownloadQuotaStore.js", () => ({
  useDownloadQuotaStore: () => ({
    limitBytes: 0,
    isMeasured: true,
    ensureMeasured: () => Promise.resolve(),
    sizeOf: (bytes: number | null | undefined) => bytes ?? 1000,
    hasRoomFor: () => true,
    reserve: vi.fn(),
    settle: vi.fn(),
    adopt: vi.fn(),
    uncharge: vi.fn(),
    forget: vi.fn(),
    refresh: () => Promise.resolve(),
    reset: vi.fn(),
  }),
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: { value: { id: "global" } },
    setActiveServer: vi.fn(),
    mediaDownloader: { resolveLocalUrl, delete: vi.fn(async () => {}), download, cancel },
    repositories: () => ({
      mediaItems: { upsert, failStaleDownloads: vi.fn(async () => []), listReady: vi.fn() },
      unitOfWork: {},
    }),
  }),
}))

import { DOWNLOAD_STALL_TIMEOUT_MS, useDownloadStore } from "../useDownloadStore.js"

const A = "track-a" as TrackId
const B = "track-b" as TrackId

const DELIVERED = {
  ok: true,
  value: { server: { id: "global" }, mediaItem: { localPath: "file:///local.mp3" } },
}

/** A transfer that never settles — the native side simply stops speaking. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

/**
 * One stalled transfer used to freeze auto-download for the rest of the
 * process: the drain held its re-entrancy flag across an `await` on a promise
 * that never settled, so every later `prefetch()` / `resumeDeferred()` returned
 * at the guard — no error, no state change on any row (#1730).
 *
 * Nothing bounded a single attempt either. The adapter's promise settles only
 * on a native `completed` / `failed` event for its own id, and there are ways
 * for neither to arrive; the hedge ceiling stops applying the moment a
 * candidate delivers its first byte.
 */
describe("useDownloadStore — a transfer that never settles", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubGlobal("navigator", { onLine: true })
    toastAction.mockResolvedValue({ kind: "expired" })
    resolveLocalUrl.mockResolvedValue(null)
    cancel.mockResolvedValue(undefined)
    upsert.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("lets the queue move on to the next lecture", async () => {
    downloadMedia.mockImplementationOnce(neverSettles).mockResolvedValue(DELIVERED)
    const store = useDownloadStore()

    store.prefetch(A, "public/a.mp3", 1000)
    store.prefetch(B, "public/b.mp3", 1000)

    // The first job is transferring; the second is waiting its turn.
    await vi.advanceTimersByTimeAsync(100)
    expect(downloadMedia).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 10_000)

    // The stalled lecture is a failure the user can retry, and the one behind
    // it got its turn instead of waiting out the session.
    expect(store.getState(A)).toBe("failed")
    expect(downloadMedia).toHaveBeenCalledTimes(2)
    expect(store.getState(B)).toBe("completed")
  })

  it("stops the native transfer it gave up on", async () => {
    downloadMedia.mockImplementation(neverSettles)
    const store = useDownloadStore()

    void store.ensureDownloaded(A, "public/a.mp3", 1000)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 10_000)

    // Abandoning it in JS alone would leave a worker free to land bytes for a
    // row we just failed — and a DB row left at "downloading" refuses the next
    // attempt with "already-in-progress" until a relaunch repairs it.
    expect(cancel).toHaveBeenCalledWith("https://cdn.test/public/a.mp3")
    expect(upsert).toHaveBeenCalledWith(A, "failed", null)
  })

  it("gives up on a probe that never answers, too", async () => {
    // The transfer is not the only platform call that can hang: an attempt
    // stuck on the cache probe holds the same queue slot.
    resolveLocalUrl.mockImplementation(neverSettles)
    const store = useDownloadStore()

    const task = store.ensureDownloaded(A, "public/a.mp3", 1000)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 10_000)

    expect(await task).toBeNull()
    expect(store.getState(A)).toBe("failed")
    expect(downloadMedia).not.toHaveBeenCalled()
  })

  it("does not give up on a transfer that is still delivering bytes", async () => {
    // A slow link is not a dead one. A lecture on a bad mobile connection can
    // legitimately take far longer than the deadline, so the clock measures
    // SILENCE and every byte the native side reports resets it. This one
    // trickles for ten minutes — five deadlines' worth — and must survive.
    download.mockImplementation(
      async (_url: string, onProgress?: (received: number, total: number) => void) => {
        for (let i = 1; i <= 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 60_000))
          onProgress?.(i, 10)
        }
        return "file:///local.mp3"
      }
    )
    downloadMedia.mockImplementation(
      async (_input: unknown, deps: { transfer: (url: string) => Promise<string> }) => {
        await deps.transfer("https://cdn.test/public/a.mp3")
        return DELIVERED
      }
    )
    const store = useDownloadStore()

    const task = store.ensureDownloaded(A, "public/a.mp3", 1000)
    await vi.advanceTimersByTimeAsync(11 * 60_000)

    expect(await task).toBe("file:///local.mp3")
    expect(store.getState(A)).toBe("completed")
    expect(cancel).not.toHaveBeenCalled()
  })
})
