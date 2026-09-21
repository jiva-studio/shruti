import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Listener = (event: Record<string, unknown>) => void

const deleteFileMock = vi.fn()
const readdirMock = vi.fn()
const downloadMock = vi.fn()
const removeMock = vi.fn()
const listeners = new Map<string, Listener>()

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Filesystem: {
    stat: vi.fn(),
    readFile: vi.fn(),
    deleteFile: (...a: unknown[]) => deleteFileMock(...a),
    readdir: (...a: unknown[]) => readdirMock(...a),
  },
}))

vi.mock("@shruti/plugin-media-downloader", () => ({
  MediaDownloader: {
    addListener: (name: string, cb: Listener) => {
      listeners.set(name, cb)
      return Promise.resolve({ remove: () => removeMock(name) })
    },
    download: (...a: unknown[]) => downloadMock(...a),
  },
}))

const { useDatabaseToFsFetcher } = await import("../useDatabaseToFsFetcher.js")

const PATH = "content/db.20.db"
const ID = `db:${PATH}`

function emit(name: string, event: Record<string, unknown>): void {
  listeners.get(name)?.(event)
}

/** The listeners are attached asynchronously; nothing can be emitted before
 *  the plugin has been handed the job. */
async function started(): Promise<void> {
  for (let i = 0; i < 50 && downloadMock.mock.calls.length === 0; i++) await Promise.resolve()
}

describe("useDatabaseToFsFetcher — download()", () => {
  beforeEach(() => {
    listeners.clear()
    deleteFileMock.mockReset().mockResolvedValue(undefined)
    downloadMock.mockReset().mockResolvedValue(undefined)
    removeMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves once the plugin reports the transfer completed", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/content/db.20.db", PATH)
    await started()

    emit("completed", { id: ID, bytesDownloaded: 2048 })

    await expect(done).resolves.toBeUndefined()
  })

  it("addresses the file by its url path and lands it in the data directory", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/content/db.20.db?v=2", PATH)
    await started()
    emit("completed", { id: ID, bytesDownloaded: 1 })
    await done

    expect(downloadMock).toHaveBeenCalledWith({
      id: ID,
      fileKey: "/content/db.20.db",
      url: "https://cdn.example/content/db.20.db?v=2",
      destination: { directory: "data", subdir: "content", filename: "db.20.db" },
    })
  })

  it("puts a file with no directory at the root of the data directory", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", "/db.db")
    await started()
    emit("completed", { id: "db:/db.db", bytesDownloaded: 1 })
    await done

    expect(downloadMock.mock.calls[0]![0]).toMatchObject({
      destination: { directory: "data", subdir: undefined, filename: "db.db" },
    })
  })

  it("reports progress to the caller and closes it out on completion", async () => {
    const onProgress = vi.fn()
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH, onProgress)
    await started()

    emit("progress", { id: ID, bytesDownloaded: 100, contentLength: 400 })
    emit("completed", { id: ID, bytesDownloaded: 400 })
    await done

    expect(onProgress.mock.calls).toEqual([
      [0, 0, true],
      [100, 400, true],
      [400, 400, false],
    ])
  })

  it("ignores events belonging to another download", async () => {
    const onProgress = vi.fn()
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH, onProgress)
    await started()

    emit("progress", { id: "db:other", bytesDownloaded: 1, contentLength: 2 })
    emit("failed", { id: "db:other", error: "not mine" })
    emit("completed", { id: ID, bytesDownloaded: 5 })

    await expect(done).resolves.toBeUndefined()
    expect(onProgress).not.toHaveBeenCalledWith(1, 2, true)
  })

  it("rejects with the plugin's reason and leaves nothing partial on disk", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH)
    await started()

    emit("failed", { id: ID, error: "connection reset" })

    await expect(done).rejects.toThrow("connection reset")
    expect(deleteFileMock).toHaveBeenCalledWith({ path: PATH, directory: "DATA" })
    expect(deleteFileMock).toHaveBeenCalledWith({ path: `${PATH}.download`, directory: "DATA" })
  })

  it("survives a cleanup that finds nothing to delete", async () => {
    deleteFileMock.mockRejectedValue(new Error("File does not exist"))
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH)
    await started()

    emit("failed", { id: ID, error: "" })

    await expect(done).rejects.toThrow("Database download failed")
  })

  it("detaches every listener once the transfer settles", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH)
    await started()
    emit("completed", { id: ID, bytesDownloaded: 1 })
    await done

    expect(removeMock.mock.calls.flat().sort()).toEqual(["completed", "failed", "progress"])
  })

  it("refuses a second download while one is in flight", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const first = fetcher.download("https://cdn.example/db.db", PATH)
    await started()

    await expect(fetcher.download("https://cdn.example/db.db", PATH)).rejects.toThrow(
      "Download already in progress"
    )

    emit("completed", { id: ID, bytesDownloaded: 1 })
    await first
  })

  it("accepts a new download after the previous one failed", async () => {
    const fetcher = useDatabaseToFsFetcher()
    const first = fetcher.download("https://cdn.example/db.db", PATH)
    await started()
    emit("failed", { id: ID, error: "offline" })
    await expect(first).rejects.toThrow("offline")

    const second = fetcher.download("https://cdn.example/db.db", PATH)

    await started()
    emit("completed", { id: ID, bytesDownloaded: 1 })
    await expect(second).resolves.toBeUndefined()
  })

  it("gives up on a transfer that goes silent, so bootstrap can offer a retry", async () => {
    vi.useFakeTimers()
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH)
    await started()
    const settled = expect(done).rejects.toThrow(/stalled/)

    await vi.advanceTimersByTimeAsync(60_000)

    await settled
  })

  it("keeps waiting while bytes keep arriving", async () => {
    vi.useFakeTimers()
    const fetcher = useDatabaseToFsFetcher()
    const done = fetcher.download("https://cdn.example/db.db", PATH)
    await started()

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50_000)
      emit("progress", { id: ID, bytesDownloaded: i * 100, contentLength: 400 })
    }
    emit("completed", { id: ID, bytesDownloaded: 400 })

    await expect(done).resolves.toBeUndefined()
  })
})

describe("useDatabaseToFsFetcher — list()", () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it("prefixes each entry with the directory it was asked about", async () => {
    readdirMock.mockResolvedValue({ files: [{ name: "db.19.db" }, { name: "db.20.db" }] })

    expect(await useDatabaseToFsFetcher().list("content")).toEqual([
      "content/db.19.db",
      "content/db.20.db",
    ])
  })

  it("reports an unreadable directory as empty", async () => {
    readdirMock.mockRejectedValue(new Error("Directory does not exist"))

    expect(await useDatabaseToFsFetcher().list("content")).toEqual([])
  })
})
