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
const resolveLocalUrlMock = vi.fn(async (o: { fileKey: string }) => {
  void o
  return { localUrl: null as string | null }
})
const deleteFileMock = vi.fn(async (o: { fileKey: string }) => void o)
const listTasksMock = vi.fn(async () => ({ tasks: [] as { id: string; state?: string }[] }))

vi.mock("@shruti/plugin-media-downloader", () => ({
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
// A second track, same host — for the destinations two tracks must not share.
const URL_C = "https://cdn.example.com/public/tracks/t-2/audio/original.mp3"
const ID_C = "/public/tracks/t-2/audio/original.mp3#cdn.example.com"

describe("useMediaDownloaderAdapter — terminal events", () => {
  beforeEach(() => {
    listeners.length = 0
    downloadMock.mockClear()
    cancelMock.mockClear()
    listTasksMock.mockClear()
    listTasksMock.mockResolvedValue({ tasks: [] })
  })

  it("resolves with the local url on `completed`", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 42 })

    await expect(pending).resolves.toBe("file:///data/original.mp3")
    expect(listeners).toHaveLength(0)
  })

  it("settles a cancelled transfer with DownloadCancelledError instead of hanging", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
    const pending = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledOnce())

    emit("failed", { id: ID_A, error: "HTTP 404" })

    await expect(pending).rejects.toThrow("HTTP 404")
    await expect(pending).rejects.not.toBeInstanceOf(DownloadCancelledError)
  })

  it("ignores terminal events addressed to another download", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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

  it("gives two tracks separate directories", async () => {
    // What lets the native side remove the directory a deleted file emptied
    // (#160): the destination mirrors the URL path, so a track's directory
    // chain holds that track's files and nothing else. Flatten the layout —
    // one directory for many tracks — and pruning after a delete would be
    // reaching into storage the deleted track never owned.
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
    const a = downloader.download(URL_A)
    const c = downloader.download(URL_C)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))

    const [first, second] = downloadMock.mock.calls.map(([o]) => o) as {
      id: string
      destination: { subdir: string; filename: string }
    }[]
    expect(first!.destination.subdir).toBe("shruti/public/tracks/t-1/audio")
    expect(second!.destination.subdir).toBe("shruti/public/tracks/t-2/audio")
    expect(first!.destination.filename).toBe("original.mp3")

    emit("completed", { id: ID_A, localUrl: "file:///data/t-1.mp3", bytesDownloaded: 1 })
    emit("completed", { id: ID_C, localUrl: "file:///data/t-2.mp3", bytesDownloaded: 1 })
    await Promise.all([a, c])
  })

  it("keeps two candidates on ONE host apart instead of superseding", async () => {
    // Regions are separated by host, and two of them can share one (a region
    // renamed, the dev region mirroring global). Reusing the id is how the
    // native side is told "same download": it cancels whatever holds that id
    // and re-enqueues — dropping a candidate that may already be writing to
    // the shared destination, whose partial the supersede path then unlinks
    // (#1603). Two live attempts therefore need two ids.
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
    const first = downloader.download(URL_A)
    const second = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))

    const ids = downloadMock.mock.calls.map(([o]) => (o as { id: string }).id)
    expect(ids[0]).toBe(ID_A)
    expect(new Set(ids).size).toBe(2)
    // Still the same file: only the task id may differ.
    expect(ids[1]!.startsWith(`${FILE_KEY}#`)).toBe(true)

    emit("completed", { id: ids[0], localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    emit("completed", { id: ids[1], localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    await Promise.all([first, second])

    // And the id is released, so a later attempt reuses the plain one.
    const third = downloader.download(URL_A)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(3))
    expect((downloadMock.mock.calls[2]![0] as { id: string }).id).toBe(ID_A)
    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    await third
  })

  it("aborts only the same-host candidate that was aborted", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
    const controller = new AbortController()
    const staying = downloader.download(URL_A)
    const leaving = downloader.download(URL_A, undefined, controller.signal)
    await vi.waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2))
    const secondId = (downloadMock.mock.calls[1]![0] as { id: string }).id

    controller.abort()

    await expect(leaving).rejects.toMatchObject({ reason: "superseded" })
    expect(cancelMock).toHaveBeenCalledWith({ id: secondId, deletePartial: false })
    expect(cancelMock).not.toHaveBeenCalledWith({ id: ID_A, deletePartial: false })

    emit("completed", { id: ID_A, localUrl: "file:///data/original.mp3", bytesDownloaded: 1 })
    await expect(staying).resolves.toBe("file:///data/original.mp3")
  })

  it("aborting a candidate rejects it as superseded and keeps the partial", async () => {
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })

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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })

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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })
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
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })

    await downloader.cancel(URL_A)

    expect(cancelMock).toHaveBeenCalledWith({ id: ID_B, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledWith({ id: FILE_KEY, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledTimes(2)
  })

  it("leaves a finished download alone when cancelling by url", async () => {
    // The eviction path (`remove`) cancels before it deletes, and by then the
    // download is long finished — so the platform lists it as the entry that
    // maps the file key to the saved file, not as a transfer. Cancelling it
    // carries `deletePartial: true`, which on the native side unlinks that
    // saved file: a cancel would be doing a delete's work, and would do it
    // for every candidate the file was raced under.
    listTasksMock.mockResolvedValue({
      tasks: [
        { id: ID_A, state: "completed" },
        { id: ID_B, state: "failed" },
        { id: FILE_KEY, state: "running" },
      ],
    })
    const downloader = useMediaDownloaderAdapter({ cacheDir: "shruti" })

    await downloader.cancel(URL_A)

    expect(cancelMock).toHaveBeenCalledWith({ id: FILE_KEY, deletePartial: true })
    expect(cancelMock).toHaveBeenCalledTimes(1)
  })
})
