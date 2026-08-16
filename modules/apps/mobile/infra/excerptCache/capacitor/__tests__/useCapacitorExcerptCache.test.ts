import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// In-memory fake of the relevant `@capacitor/filesystem` surface. Files are
// keyed by `<directory>/<path>` and carry a byte size. `rename` moves the
// entry atomically; a torn / partial download is modelled as a `.tmp` file
// that is NEVER renamed onto its final path.
// ---------------------------------------------------------------------------
type FakeFile = { size: number }
const fs = new Map<string, FakeFile>()

function key(directory: string, path: string): string {
  return `${directory}::${path}`
}

const statMock = vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
  const f = fs.get(key(directory, path))
  if (!f) throw new Error("File does not exist")
  return { size: f.size, type: "file", mtime: 0, ctime: 0, uri: `file:///${directory}/${path}` }
})

const getUriMock = vi.fn(async ({ path, directory }: { path: string; directory: string }) => ({
  uri: `file:///${directory}/${path}`,
}))

const renameMock = vi.fn(
  async ({ from, to, directory }: { from: string; to: string; directory: string }) => {
    const f = fs.get(key(directory, from))
    if (!f) throw new Error("Source does not exist")
    fs.delete(key(directory, from))
    fs.set(key(directory, to), f)
  }
)

const deleteFileMock = vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
  fs.delete(key(directory, path))
})

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE", Data: "DATA" },
  Filesystem: {
    stat: (o: never) => statMock(o),
    getUri: (o: never) => getUriMock(o),
    rename: (o: never) => renameMock(o),
    deleteFile: (o: never) => deleteFileMock(o),
  },
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { convertFileSrc: (u: string) => `http://localhost/_capacitor_file_/${u}` },
}))

// ---------------------------------------------------------------------------
// Fake MediaDownloader. `download` streams to `destination.filename`. By
// default it succeeds (writes a full multi-MB file then emits `completed`).
// Tests can override `behaviour` to model a torn / aborted download.
// ---------------------------------------------------------------------------
type Listener = (e: unknown) => void
const listeners: { event: string; fn: Listener }[] = []

const downloadBehaviour = {
  // "complete" | "partial" | "fail"
  mode: "complete" as "complete" | "partial" | "fail",
}

const downloadMock = vi.fn(
  async ({
    id,
    destination,
  }: {
    id: string
    url: string
    destination: { directory: string; subdir: string; filename: string }
  }) => {
    const dir = destination.directory === "cache" ? "CACHE" : "DATA"
    const path = destination.subdir
      ? `${destination.subdir}/${destination.filename}`
      : destination.filename
    if (downloadBehaviour.mode === "complete") {
      // Full file written to the (temp) path, then `completed`.
      fs.set(key(dir, path), { size: 5_000_000 })
      emit("completed", { id, localUrl: `file:///${dir}/${path}` })
    } else if (downloadBehaviour.mode === "partial") {
      // Process killed mid-stream: a non-zero partial file is left at the
      // temp path and NO `completed`/`failed` event is delivered — the
      // download promise rejects via the test's explicit `failed` emit.
      fs.set(key(dir, path), { size: 1_200_000 })
      emit("failed", { id, error: "aborted", retryable: true })
    } else {
      emit("failed", { id, error: "boom", retryable: false })
    }
    return { id, state: "running", bytesDownloaded: 0, contentLength: 0 }
  }
)

function emit(event: string, payload: unknown) {
  for (const l of listeners) if (l.event === event) l.fn(payload)
}

vi.mock("@shruti/plugin-media-downloader", () => ({
  MediaDownloader: {
    download: (o: never) => downloadMock(o),
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

import { useCapacitorExcerptCache } from "../useCapacitorExcerptCache.js"

const CACHE_DIR = "shruti/excerpts"

describe("useCapacitorExcerptCache — download atomicity", () => {
  beforeEach(() => {
    fs.clear()
    listeners.length = 0
    downloadBehaviour.mode = "complete"
    statMock.mockClear()
    getUriMock.mockClear()
    renameMock.mockClear()
    deleteFileMock.mockClear()
    downloadMock.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  const filename = "share-track-note-abc.mp3"

  it("downloads to a temp path and atomically renames onto the final file", async () => {
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })
    const uri = await cache.download({ url: "https://cdn/x.mp3", filename })

    // The plugin was told to write to the temp path, not the final one.
    expect(downloadMock).toHaveBeenCalledOnce()
    expect(downloadMock.mock.calls[0]![0].destination).toEqual({
      directory: "data",
      subdir: CACHE_DIR,
      filename: `${filename}.tmp`,
    })

    // A rename published the temp file onto the canonical filename.
    expect(renameMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `${CACHE_DIR}/${filename}.tmp`,
        to: `${CACHE_DIR}/${filename}`,
        directory: "DATA",
      })
    )

    // Only the final file exists; the temp entry is gone.
    expect(fs.has(key("DATA", `${CACHE_DIR}/${filename}`))).toBe(true)
    expect(fs.has(key("DATA", `${CACHE_DIR}/${filename}.tmp`))).toBe(false)
    expect(uri).toBe(`file:///DATA/${CACHE_DIR}/${filename}`)
  })

  it("serves a completed download via findLocal", async () => {
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })
    await cache.download({ url: "https://cdn/x.mp3", filename })

    const found = await cache.findLocal(filename)
    expect(found).toBe(`file:///DATA/${CACHE_DIR}/${filename}`)
  })

  it("does NOT serve a partially-written (torn) excerpt", async () => {
    downloadBehaviour.mode = "partial"
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })

    // The interrupted download rejects (no atomic publish happened).
    await expect(cache.download({ url: "https://cdn/x.mp3", filename })).rejects.toThrow()

    // No rename onto the canonical name → findLocal sees nothing to serve,
    // even though a non-zero partial was left at the TEMP path.
    expect(renameMock).not.toHaveBeenCalled()
    expect(fs.has(key("DATA", `${CACHE_DIR}/${filename}`))).toBe(false)
    expect(await cache.findLocal(filename)).toBeNull()

    // The torn temp file is cleaned up, not leaked.
    expect(fs.has(key("DATA", `${CACHE_DIR}/${filename}.tmp`))).toBe(false)
  })

  it("cleans up the temp file when the download fails outright", async () => {
    downloadBehaviour.mode = "fail"
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })

    await expect(cache.download({ url: "https://cdn/x.mp3", filename })).rejects.toThrow("boom")
    expect(deleteFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${CACHE_DIR}/${filename}.tmp`, directory: "DATA" })
    )
  })

  it("findLocal returns null for a zero-byte leftover", async () => {
    fs.set(key("DATA", `${CACHE_DIR}/${filename}`), { size: 0 })
    const cache = useCapacitorExcerptCache({ cacheDir: CACHE_DIR })
    expect(await cache.findLocal(filename)).toBeNull()
  })
})
