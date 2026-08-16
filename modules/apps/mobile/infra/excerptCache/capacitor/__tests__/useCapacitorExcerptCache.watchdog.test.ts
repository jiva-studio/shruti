import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// #1833, excerpt-cache half. Same defect as the remote-files adapter: the
// download promise was settled only by `completed` / `failed`, so a job the
// platform parks (offline Android WorkManager) left `download()` pending
// forever — and with it `useShareTrack.run`'s full-screen loading modal, which
// has no cancel and no backdrop dismiss, plus the app-wide single share slot.
// ---------------------------------------------------------------------------
const { downloadMock, cancelMock, addListenerMock, deleteFileMock, renameMock } = vi.hoisted(
  () => ({
    downloadMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    cancelMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    addListenerMock: vi.fn(async () => ({ remove: async () => {} })),
    deleteFileMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    renameMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  })
)

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE", Data: "DATA" },
  Filesystem: {
    stat: vi.fn(async () => {
      throw new Error("File does not exist")
    }),
    getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///DATA/${path}` })),
    rename: renameMock,
    deleteFile: deleteFileMock,
  },
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { convertFileSrc: (u: string) => u },
}))

vi.mock("@shruti/plugin-media-downloader", () => ({
  MediaDownloader: {
    download: downloadMock,
    cancel: cancelMock,
    addListener: addListenerMock,
  },
}))

import { DOWNLOAD_STALL_TIMEOUT_MS } from "@infra/watchDownload.js"
import { useCapacitorExcerptCache } from "../useCapacitorExcerptCache.js"

const CACHE_DIR = "shruti/excerpts"
const REQUEST = { url: "https://cdn.example.com/shares/audio/n1.mp3", filename: "share-n1.mp3" }

describe("useCapacitorExcerptCache — parked download watchdog (#1833)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fails `download()` once the transfer has been silent for the stall budget", async () => {
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })

    const settled = cache.download(REQUEST).then(
      () => "resolved",
      (e: Error) => e
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(downloadMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS - 1)
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending")

    await vi.advanceTimersByTimeAsync(1)
    const result = await settled
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/stalled/)
  })

  it("publishes nothing and sweeps the temp when the transfer stalls", async () => {
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })

    const settled = cache.download(REQUEST).then(
      () => "resolved",
      (e: Error) => e
    )
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS)
    expect(await settled).toBeInstanceOf(Error)

    // A stalled transfer must never be published onto the canonical name —
    // `findLocal` would then serve a partial as a valid cache hit.
    expect(renameMock).not.toHaveBeenCalled()
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: `${CACHE_DIR}/share-n1.mp3.tmp`,
      directory: "DATA",
    })
    expect(cancelMock).toHaveBeenCalledWith({ id: "share-n1.mp3.tmp", deletePartial: true })
  })

  it("still publishes a transfer that completes after quiet stretches", async () => {
    let onProgress: ((e: { id: string }) => void) | undefined
    let onCompleted: ((e: { id: string; localUrl: string }) => void) | undefined
    addListenerMock.mockImplementation((async (event: string, fn: (e: unknown) => void) => {
      if (event === "progress") onProgress = fn as (e: { id: string }) => void
      if (event === "completed") onCompleted = fn as (e: { id: string; localUrl: string }) => void
      return { remove: async () => {} }
    }) as unknown as typeof addListenerMock)

    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })
    const pending = cache.download(REQUEST)
    await vi.advanceTimersByTimeAsync(0)

    const id = "share-n1.mp3.tmp"
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS - 1)
      onProgress?.({ id })
    }
    onCompleted?.({ id, localUrl: `file:///DATA/${CACHE_DIR}/${id}` })

    await expect(pending).resolves.toBe(`file:///DATA/${CACHE_DIR}/share-n1.mp3`)
    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(cancelMock).not.toHaveBeenCalled()
  })
})
