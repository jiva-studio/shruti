import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Fakes for the `@capacitor/filesystem` surface the storage adapter touches.
// `renameMock` is the unit under test for #29: when it rejects, the adapter
// must best-effort delete the `.tmp` sibling rather than leak it.
// ---------------------------------------------------------------------------
// Declared via `vi.hoisted` so they exist when the hoisted `vi.mock` factories
// below reference them (and can be assigned directly as the mocked methods,
// avoiding wrapper closures with unused params).
const { writeFileMock, renameMock, deleteFileMock, readFileMock, rmdirMock, resolveLocalUrlMock } =
  vi.hoisted(() => ({
    writeFileMock: vi.fn<(o: unknown) => Promise<{ uri: string }>>(async () => ({
      uri: "file:///written",
    })),
    renameMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    deleteFileMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
    readFileMock: vi.fn<(o: unknown) => Promise<{ data: string }>>(async () => ({
      data: JSON.stringify({ cached: true }),
    })),
    rmdirMock: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
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

    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "cache" })
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

    const storage = useCapacitorRemoteFilesStorage({ cacheDir: "cache" })
    await storage.getJson("https://cdn/foo.json")
    await flush()

    expect(renameMock).toHaveBeenCalledOnce()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })
})
