import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Fakes for the `@capacitor/filesystem` surface the storage adapter touches.
// `renameMock` is the unit under test for #29: when it rejects, the adapter
// must best-effort delete the `.tmp` sibling rather than leak it.
// ---------------------------------------------------------------------------
// Declared via `vi.hoisted` so they exist when the hoisted `vi.mock` factories
// below reference them (and can be assigned directly as the mocked methods,
// avoiding wrapper closures with unused params).
const {
  writeFileMock,
  renameMock,
  deleteFileMock,
  readFileMock,
  rmdirMock,
  readdirMock,
  resolveLocalUrlMock,
} = vi.hoisted(() => ({
  writeFileMock: vi.fn<(o: unknown) => Promise<{ uri: string }>>(async () => ({
    uri: "file:///written",
  })),
  renameMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  deleteFileMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  readFileMock: vi.fn<(o: unknown) => Promise<{ data: string }>>(async () => ({
    data: JSON.stringify({ cached: true }),
  })),
  rmdirMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  readdirMock: vi.fn<(o: unknown) => Promise<{ files: { name: string; type: string }[] }>>(
    async () => ({ files: [] })
  ),
  resolveLocalUrlMock: vi.fn<(o: unknown) => Promise<{ localUrl: string | null }>>(async () => ({
    localUrl: "file:///DATA/cache/foo.json",
  })),
}))

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA", Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    writeFile: writeFileMock,
    rename: renameMock,
    deleteFile: deleteFileMock,
    readFile: readFileMock,
    rmdir: rmdirMock,
    readdir: readdirMock,
  },
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { convertFileSrc: (u: string) => u },
}))

vi.mock("@lectorium/plugin-media-downloader", () => ({
  MediaDownloader: {
    resolveLocalUrl: resolveLocalUrlMock,
    download: vi.fn(),
    deleteFile: vi.fn(),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}))

import { createJsonRemoteStorage } from "@kit/infra"
import { useCapacitorRemoteFilesStorage } from "../useCapacitorRemoteFilesStorage.js"

describe("useCapacitorRemoteFilesStorage — temp cleanup on rename failure (#29)", () => {
  let originalFetch: typeof globalThis.fetch
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockResolvedValue({ data: JSON.stringify({ cached: true }) })
    resolveLocalUrlMock.mockResolvedValue({ localUrl: "file:///DATA/cache/foo.json" })
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // The stale-while-revalidate refresh runs detached (`void (async () => …)`),
  // so let queued microtasks drain before asserting on it.
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it("deletes the .tmp sibling when the atomic rename fails during refresh", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ fresh: true }), { status: 200 }))
    renameMock.mockRejectedValueOnce(new Error("rename failed"))

    const storage = createJsonRemoteStorage(useCapacitorRemoteFilesStorage({ cacheDir: "cache" }))
    const result = await storage.getJson<{ cached: boolean }>("https://cdn/foo.json")

    // Cached value is still returned synchronously from the cold-start read.
    expect(result).toEqual({ cached: true })

    await flush()

    // Refresh wrote the temp file, attempted the rename, and on failure
    // cleaned up the `.tmp` orphan.
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "file:///DATA/cache/foo.json.tmp" })
    )
    expect(renameMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).toHaveBeenCalledWith({ path: "file:///DATA/cache/foo.json.tmp" })
  })

  it("does not delete anything when the rename succeeds", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ fresh: true }), { status: 200 }))

    const storage = createJsonRemoteStorage(useCapacitorRemoteFilesStorage({ cacheDir: "cache" }))
    await storage.getJson("https://cdn/foo.json")
    await flush()

    expect(renameMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })
})

describe("useCapacitorRemoteFilesStorage — clearAll scope (#1630)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readdirMock.mockResolvedValue({
      files: [
        { name: "databases", type: "directory" },
        { name: "media", type: "directory" },
        { name: "transcripts", type: "directory" },
        { name: "config.json", type: "file" },
      ],
    })
  })

  it("leaves the content database in place while clearing everything else", async () => {
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium", keep: ["databases"] })

    await storage.clearAll()

    // The whole point: "Clear cache" must never cost a ~54 MB re-download.
    expect(rmdirMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "lectorium/databases" })
    )
    // …and it must never take the cache root out from under it either.
    expect(rmdirMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: "lectorium" }))
    expect(rmdirMock).toHaveBeenCalledWith({
      path: "lectorium/media",
      directory: "DATA",
      recursive: true,
    })
    expect(rmdirMock).toHaveBeenCalledWith({
      path: "lectorium/transcripts",
      directory: "DATA",
      recursive: true,
    })
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "lectorium/config.json",
      directory: "DATA",
    })
  })

  it("keeps sweeping after one entry fails to delete", async () => {
    rmdirMock.mockRejectedValueOnce(new Error("locked"))
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium", keep: ["databases"] })

    await expect(storage.clearAll()).resolves.toBeUndefined()
    expect(rmdirMock).toHaveBeenCalledTimes(2)
    expect(deleteFileMock).toHaveBeenCalledOnce()
  })

  it("is a no-op when the cache root doesn't exist", async () => {
    readdirMock.mockRejectedValueOnce(new Error("no such directory"))
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium", keep: ["databases"] })

    await expect(storage.clearAll()).resolves.toBeUndefined()
    expect(rmdirMock).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })
})

describe("useCapacitorRemoteFilesStorage — partials inside a kept dir (#1663)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readdirMock.mockImplementation(async (o: unknown) => {
      const { path } = o as { path: string }
      if (path === "lectorium") {
        return {
          files: [
            { name: "databases", type: "directory" },
            { name: "media", type: "directory" },
          ],
        }
      }
      if (path === "lectorium/databases") {
        return {
          files: [
            { name: "lectorium.8.db.download", type: "file" },
            { name: "config.json.tmp", type: "file" },
            { name: "lectorium.9.db", type: "file" },
            { name: "user.db", type: "file" },
            { name: "nested", type: "directory" },
          ],
        }
      }
      return { files: [] }
    })
  })

  it("reclaims the download leftovers the kept directory used to hide", async () => {
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium", keep: ["databases"] })

    await storage.clearAll()

    // An interrupted transfer's temp is never a usable file, and `keep` was the
    // only thing standing between it and an uninstall.
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "lectorium/databases/lectorium.8.db.download",
      directory: "DATA",
    })
    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "lectorium/databases/config.json.tmp",
      directory: "DATA",
    })
    // …while the catalog, the user DB and any subdirectory are untouched —
    // that is what `keep` is for (#1630).
    expect(deleteFileMock).toHaveBeenCalledTimes(2)
    expect(rmdirMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "lectorium/databases" })
    )
    expect(rmdirMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "lectorium/databases/nested" })
    )
  })

  it("keeps sweeping the kept dir when one partial can't be deleted", async () => {
    deleteFileMock.mockRejectedValueOnce(new Error("locked"))
    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "lectorium", keep: ["databases"] })

    await expect(storage.clearAll()).resolves.toBeUndefined()
    expect(deleteFileMock).toHaveBeenCalledTimes(2)
  })
})
