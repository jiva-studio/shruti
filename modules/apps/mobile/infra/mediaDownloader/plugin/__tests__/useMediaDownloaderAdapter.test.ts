import { beforeEach, describe, expect, it, vi } from "vitest"
import { DownloadCancelledError } from "@ports/app/index.js"

// ---------------------------------------------------------------------------
// Fake MediaDownloader plugin. `download()` only enqueues — tests drive the
// lifecycle by emitting the events the native side would send, which is the
// whole point here: the adapter's promise must settle on EVERY terminal
// event, including a cancellation (issue #1489, where the Android observer
// detached silently and left the caller pending forever).
// ---------------------------------------------------------------------------
type Listener = (e: unknown) => void
const listeners: { event: string; fn: Listener }[] = []

function emit(event: string, payload: unknown) {
  for (const l of [...listeners]) if (l.event === event) l.fn(payload)
}

const downloadMock = vi.fn(async ({ id }: { id: string }) => ({
  id,
  state: "running",
  bytesDownloaded: 0,
  contentLength: 0,
}))
const cancelMock = vi.fn(async (o: { id: string; deletePartial?: boolean }) => void o)

vi.mock("@lectorium/plugin-media-downloader", () => ({
  MediaDownloader: {
    download: (o: never) => downloadMock(o),
    cancel: (o: never) => cancelMock(o),
    addListener: vi.fn(async (event: string, fn: Listener) => {
      const entry = { event, fn }
      listeners.push(entry)
      return {
        remove: async () => {
          const i = listeners.indexOf(entry)
          if (i >= 0) listeners.splice(i, 1)
        },
      }
    }),
  },
}))

import { useMediaDownloaderAdapter } from "../useMediaDownloaderAdapter.js"

const URL_A = "https://cdn.example.com/public/tracks/t-1/audio/original.mp3"
const ID_A = "/public/tracks/t-1/audio/original.mp3"

describe("useMediaDownloaderAdapter — terminal events", () => {
  beforeEach(() => {
    listeners.length = 0
    downloadMock.mockClear()
    cancelMock.mockClear()
  })

  it("resolves with the local url on `completed`", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 42 })

    await expect(pending).resolves.toBe("file:///data/original.mp3")
    expect(listeners).toHaveLength(0)
  })

  it("settles a cancelled transfer with DownloadCancelledError instead of hanging", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    await downloader.cancel(URL_A)
    expect(cancelMock).toHaveBeenCalledWith({ id: ID_A, deletePartial: true })
    // What every platform emits for a cancellation.
    emit("failed", { id: ID_A, error: "cancelled", retryable: false, code: "cancelled" })

    await expect(pending).rejects.toBeInstanceOf(DownloadCancelledError)
    // Listeners are released, so the download slot can be reused.
    expect(listeners).toHaveLength(0)
  })

  it("settles a transfer whose file was removed mid-flight as a cancellation", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    // `deleteFile()` dropped the bookkeeping while the transfer finished:
    // deliberate local action, so it must NOT read as a CDN fault (which
    // would rotate to the next server for bytes the user just deleted).
    emit("failed", { id: ID_A, error: "download was removed", retryable: false, code: "removed" })

    await expect(pending).rejects.toBeInstanceOf(DownloadCancelledError)
    expect(listeners).toHaveLength(0)
  })

  it("rejects a genuine failure with the reported error, not a cancellation", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("failed", { id: ID_A, error: "HTTP 404", retryable: false })

    await expect(pending).rejects.toThrow("HTTP 404")
    await expect(pending).rejects.not.toBeInstanceOf(DownloadCancelledError)
  })

  it("ignores terminal events addressed to another download", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("failed", {
      id: "/public/tracks/t-2/audio/original.mp3",
      code: "cancelled",
      error: "cancelled",
      retryable: false,
    })
    let settled = false
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    await expect(pending).resolves.toBe("file:///data/original.mp3")
  })
})
