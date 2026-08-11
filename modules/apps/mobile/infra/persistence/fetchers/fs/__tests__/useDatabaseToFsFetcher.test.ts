import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** 16-byte SQLite magic header (final byte is NUL). */
const SQLITE_HEADER = "SQLite format 3\0"

const statMock = vi.fn()
const readFileMock = vi.fn()
const deleteFileMock = vi.fn()
const readdirMock = vi.fn()

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Filesystem: {
    stat: (...a: unknown[]) => statMock(...a),
    readFile: (...a: unknown[]) => readFileMock(...a),
    deleteFile: (...a: unknown[]) => deleteFileMock(...a),
    readdir: (...a: unknown[]) => readdirMock(...a),
  },
}))

// The fetcher imports the plugin for `download()`; we only exercise `exists()`,
// so a bare stub is enough to let the module load under the node environment.
vi.mock("@shruti/plugin-media-downloader", () => ({
  MediaDownloader: { addListener: vi.fn(), download: vi.fn() },
}))

const { useDatabaseToFsFetcher } = await import("../useDatabaseToFsFetcher.js")

/** Encode a binary string as base64 the way the native filesystem returns it. */
function b64(s: string): string {
  // `btoa` operates on a binary (latin1) string — exactly our header bytes.
  return btoa(s)
}

describe("useDatabaseToFsFetcher — exists() integrity validation", () => {
  beforeEach(() => {
    statMock.mockReset()
    readFileMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns true for a present file whose header is the SQLite magic", async () => {
    const body = SQLITE_HEADER + "payload"
    statMock.mockResolvedValue({ size: body.length })
    readFileMock.mockResolvedValue({ data: b64(SQLITE_HEADER) })

    const ok = await useDatabaseToFsFetcher().exists("content/db.20.db")
    expect(ok).toBe(true)
  })

  it("returns false (no throw) for a file shorter than the 16-byte header", async () => {
    statMock.mockResolvedValue({ size: 6 })

    const ok = await useDatabaseToFsFetcher().exists("content/db.20.db")
    expect(ok).toBe(false)
    // Short-circuits on size; never reads the body.
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("returns false for a file with a wrong (non-SQLite) header", async () => {
    statMock.mockResolvedValue({ size: 4096 })
    readFileMock.mockResolvedValue({ data: b64("NOTASQLITEDB____") })

    const ok = await useDatabaseToFsFetcher().exists("content/db.20.db")
    expect(ok).toBe(false)
  })

  it("returns false (no throw) when stat throws — the file is absent", async () => {
    statMock.mockRejectedValue(new Error("File does not exist"))

    const ok = await useDatabaseToFsFetcher().exists("content/db.20.db")
    expect(ok).toBe(false)
  })
})

describe("useDatabaseToFsFetcher — delete() reclaims the partial sibling (#1663)", () => {
  beforeEach(() => {
    deleteFileMock.mockReset()
    deleteFileMock.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("drops the `.download` temp along with the database file", async () => {
    await useDatabaseToFsFetcher().delete("shruti/databases/shruti.8.db")

    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "shruti/databases/shruti.8.db",
      directory: "DATA",
    })
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "shruti/databases/shruti.8.db.download",
      directory: "DATA",
    })
  })

  it("still takes the partial when the database file itself is already gone", async () => {
    // The case the `download()` catch cannot cover: a process killed mid-
    // transfer never reaches it, so all that is left on disk is the temp.
    deleteFileMock.mockRejectedValueOnce(new Error("File does not exist"))

    await expect(
      useDatabaseToFsFetcher().delete("shruti/databases/shruti.8.db")
    ).resolves.toBeUndefined()
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "shruti/databases/shruti.8.db.download",
      directory: "DATA",
    })
  })
})
