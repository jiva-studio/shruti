import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// #1833 — a download the platform PARKS (Android WorkManager holds the job
// under its `NetworkType.CONNECTED` constraint while offline) emits neither
// `completed` nor `failed`. The adapter used to await those two events and
// nothing else, so `get()` / `getText()` never settled and the transcript
// reader sat on "Loading transcript…" forever.
//
// The fake plugin below models exactly that: `download()` resolves (the job
// was accepted) and then no event is ever emitted.
// ---------------------------------------------------------------------------
const { downloadMock, cancelMock, resolveLocalUrlMock, addListenerMock, readFileMock } = vi.hoisted(
  () => ({
    downloadMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    cancelMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    resolveLocalUrlMock: vi.fn<(o: unknown) => Promise<{ localUrl: string | null }>>(async () => ({
      localUrl: null,
    })),
    addListenerMock: vi.fn(async () => ({ remove: async () => {} })),
    readFileMock: vi.fn<(o: unknown) => Promise<{ data: string }>>(async () => ({ data: "{}" })),
  })
)

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA", Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    readFile: readFileMock,
    writeFile: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
    readdir: vi.fn(async () => ({ files: [] })),
    rmdir: vi.fn(),
  },
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { convertFileSrc: (u: string) => u },
}))

vi.mock("@lectorium/plugin-media-downloader", () => ({
  MediaDownloader: {
    resolveLocalUrl: resolveLocalUrlMock,
    download: downloadMock,
    cancel: cancelMock,
    deleteFile: vi.fn(),
    addListener: addListenerMock,
  },
}))

import { DOWNLOAD_STALL_TIMEOUT_MS } from "@infra/watchDownload.js"
import { useCapacitorRemoteFilesStorage } from "../useCapacitorRemoteFilesStorage.js"

const URL_UNDER_TEST = "https://cdn.example.com/tracks/t1/transcripts/en.json"

describe("useCapacitorRemoteFilesStorage — parked download watchdog (#1833)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveLocalUrlMock.mockResolvedValue({ localUrl: null })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fails `get()` once the transfer has been silent for the stall budget", async () => {
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium" })

    const pending = storage.get(URL_UNDER_TEST)
    const settled = pending.then(
      () => "resolved",
      (e: Error) => e
    )
    // Let the listener registration + `download()` dispatch run.
    await vi.advanceTimersByTimeAsync(0)
    expect(downloadMock).toHaveBeenCalledTimes(1)

    // Still parked just before the budget: the caller is deliberately blocked.
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS - 1)
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending")

    await vi.advanceTimersByTimeAsync(1)
    const result = await settled
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/stalled/)
  })

  it("fails the first-ever `getText()` rather than hanging, and never reads the file", async () => {
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium" })

    const pending = storage.getText(URL_UNDER_TEST)
    const settled = pending.then(
      () => "resolved",
      (e: Error) => e
    )
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS)

    expect(await settled).toBeInstanceOf(Error)
    // Nothing landed on disk, so the adapter must not go on to read a path
    // that would either be missing or a half-written partial.
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("cancels the parked native job so it cannot land after the caller gave up", async () => {
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium" })

    const settled = storage.get(URL_UNDER_TEST).then(
      () => "resolved",
      (e: Error) => e
    )
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS)
    expect(await settled).toBeInstanceOf(Error)

    expect(cancelMock).toHaveBeenCalledWith({
      id: "/tracks/t1/transcripts/en.json",
      deletePartial: true,
    })
  })

  it("keeps waiting while the transfer reports progress", async () => {
    let onProgress: ((e: { id: string }) => void) | undefined
    let onCompleted: ((e: { id: string; localUrl: string }) => void) | undefined
    addListenerMock.mockImplementation((async (event: string, fn: (e: unknown) => void) => {
      if (event === "progress") onProgress = fn as (e: { id: string }) => void
      if (event === "completed") onCompleted = fn as (e: { id: string; localUrl: string }) => void
      return { remove: async () => {} }
    }) as unknown as typeof addListenerMock)

    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium" })
    const pending = storage.get(URL_UNDER_TEST)
    await vi.advanceTimersByTimeAsync(0)

    const id = "/tracks/t1/transcripts/en.json"
    // Three quiet stretches, each just under the budget, each re-armed by a
    // progress event: a slow-but-live transfer must not be shot.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS - 1)
      onProgress?.({ id })
    }
    onCompleted?.({ id, localUrl: "file:///DATA/lectorium/en.json" })

    await expect(pending).resolves.toBe("file:///DATA/lectorium/en.json")
    expect(cancelMock).not.toHaveBeenCalled()
  })
})
