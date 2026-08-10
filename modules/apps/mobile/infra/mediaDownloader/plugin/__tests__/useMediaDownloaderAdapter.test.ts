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
const resolveLocalUrlMock = vi.fn(async (_o: { fileKey: string }) => ({
  localUrl: null as string | null,
}))
const deleteFileMock = vi.fn(async (_o: { fileKey: string }) => undefined)
const listTasksMock = vi.fn(async () => ({ tasks: [] as { id: string }[] }))

vi.mock("@lectorium/plugin-media-downloader", () => ({
  MediaDownloader: {
    download: (o: never) => downloadMock(o),
    cancel: (o: never) => cancelMock(o),
    resolveLocalUrl: (o: never) => resolveLocalUrlMock(o),
    deleteFile: (o: never) => deleteFileMock(o),
    listTasks: () => listTasksMock(),
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
const URL_B = "https://other.example.com/public/tracks/t-1/audio/original.mp3"
// One file, one destination — but each CDN candidate is its own native task,
// so the host is part of the id. Without that a hedged candidate would
// supersede its rival instead of racing it.
const FILE_KEY = "/public/tracks/t-1/audio/original.mp3"
const ID_A = `${FILE_KEY}#cdn.example.com`
const ID_B = `${FILE_KEY}#other.example.com`

describe("useMediaDownloaderAdapter — terminal events", () => {
  beforeEach(() => {
    listeners.length = 0
    downloadMock.mockClear()
    cancelMock.mockClear()
    listTasksMock.mockClear()
    listTasksMock.mockResolvedValue({ tasks: [] })
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
    emit("failed", { id: ID_A, error: "cancelled", code: "cancelled" })

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
    emit("failed", { id: ID_A, error: "download was removed", code: "removed" })

    await expect(pending).rejects.toBeInstanceOf(DownloadCancelledError)
    expect(listeners).toHaveLength(0)
  })

  it("rejects a genuine failure with the reported error, not a cancellation", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("failed", { id: ID_A, error: "HTTP 404" })

    await expect(pending).rejects.toThrow("HTTP 404")
    await expect(pending).rejects.not.toBeInstanceOf(DownloadCancelledError)
  })

  it("ignores terminal events addressed to another download", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("failed", {
      id: "/public/tracks/t-2/audio/original.mp3#cdn.example.com",
      code: "cancelled",
      error: "cancelled",
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

describe("useMediaDownloaderAdapter — hedged candidates", () => {
  beforeEach(() => {
    listeners.length = 0
    downloadMock.mockClear()
    cancelMock.mockClear()
    listTasksMock.mockClear()
    listTasksMock.mockResolvedValue({ tasks: [] })
  })

  it("gives each CDN candidate its own native task but one destination", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const a = downloader.download(URL_A)
    const b = downloader.download(URL_B)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))

    const [first, second] = downloadMock.mock.calls.map(([o]) => o) as {
      id: string
      destination: unknown
    }[]
    expect(first!.id).toBe(ID_A)
    expect(second!.id).toBe(ID_B)
    // Same file on disk: the winner-cancels-the-losers rule is what keeps a
    // single writer, not a temp file per candidate.
    expect(first!.destination).toEqual(second!.destination)

    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    emit("completed", { id: ID_B, localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    await Promise.all([a, b])
  })

  it("aborting a candidate rejects it as superseded and keeps the partial", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const controller = new AbortController()
    const loser = downloader.download(URL_B, undefined, controller.signal)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    controller.abort()

    await expect(loser).rejects.toMatchObject({
      name: "DownloadCancelledError",
      reason: "superseded",
    })
    // `deletePartial` must stay false — the winner is writing that very file.
    expect(cancelMock).toHaveBeenCalledWith({ id: ID_B, deletePartial: false })
  })

  it("asks for a saved file by something the CDN cannot change", async () => {
    // The scenario a region flip produces, with no network involved: the file
    // was saved while one CDN was active, and is looked up while another is.
    // Both addresses name the SAME file — only the host differs, and the
    // on-disk destination deliberately ignores the host.
    //
    // This is currently RED against the native contract and green against the
    // web one, which is the actual defect (#1602): `DownloadStore.findByUrl`
    // compares the whole URL string, while the web implementation keys by
    // `URL.pathname`. Two implementations of one contract disagreeing is why
    // no browser test can speak for a device here. The lookup argument must
    // therefore carry the file'"'"'s identity, not an address that a promotion,
    // a probe or a hedge can change under it.
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })

    await downloader.resolveLocalUrl(URL_A)
    await downloader.resolveLocalUrl(URL_B)

    // The argument itself must be identical — reducing both to a path before
    // comparing would erase exactly the difference this is about, and the
    // assertion would hold no matter what the adapter passed down.
    expect(resolveLocalUrlMock.mock.calls[0]![0]).toEqual({ fileKey: FILE_KEY })
    expect(resolveLocalUrlMock.mock.calls[1]![0]).toEqual({ fileKey: FILE_KEY })
  })

  it("deletes a saved file by that same identity", async () => {
    // Same rule on the way out: a delete issued while a different CDN is
    // active must still name the file that is on disk, or the row goes and
    // the bytes stay.
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })

    await downloader.delete(URL_A)
    await downloader.delete(URL_B)

    expect(deleteFileMock.mock.calls[0]![0]).toEqual({ fileKey: FILE_KEY })
    expect(deleteFileMock.mock.calls[1]![0]).toEqual({ fileKey: FILE_KEY })
  })

  it("the winner still resolves while a dropped rival never settles natively", async () => {
    // The hedge's whole shape: candidate A connects and goes silent, B is
    // started alongside it, B delivers, and A is aborted as superseded. The
    // point here is that A's native task NEVER reports anything afterwards —
    // a silent CDN does not send a `failed` for an abort it never noticed —
    // so the winner must not be waiting on anything belonging to the loser.
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const controller = new AbortController()
    const silent = downloader.download(URL_A, undefined, controller.signal)
    const winner = downloader.download(URL_B)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))

    controller.abort()
    emit("completed", {
      id: ID_B,
      localUrl: "file:///data/audio.mp3",
      bytesDownloaded: 10,
    })

    await expect(winner).resolves.toBe("file:///data/audio.mp3")
    await expect(silent).rejects.toMatchObject({ reason: "superseded" })
  })

  it("a user cancel stops every live candidate and tags them `user`", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })
    const a = downloader.download(URL_A)
    const b = downloader.download(URL_B)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))

    // Cancelling with ONE region's url must stop the transfer whichever
    // region it was started against.
    await downloader.cancel(URL_A)
    expect(cancelMock).toHaveBeenCalledWith({ id: ID_A, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledWith({ id: ID_B, deletePartial: true })

    emit("failed", { id: ID_A, error: "cancelled", code: "cancelled" })
    emit("failed", { id: ID_B, error: "cancelled", code: "cancelled" })

    await expect(a).rejects.toMatchObject({ reason: "user" })
    await expect(b).rejects.toMatchObject({ reason: "user" })
  })

  it("cancels transfers that outlived a restart by asking the platform", async () => {
    // Nothing in flight in this session, so the attempt ids are unknown —
    // they were written by the process that started the download.
    listTasksMock.mockResolvedValue({
      tasks: [{ id: ID_B }, { id: FILE_KEY }, { id: "/public/tracks/t-2/audio/x.mp3#h" }],
    })
    const downloader = useMediaDownloaderAdapter({ cacheDir: "lectorium" })

    await downloader.cancel(URL_A)

    expect(cancelMock).toHaveBeenCalledWith({ id: ID_B, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledWith({ id: FILE_KEY, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledTimes(2)
  })
})
