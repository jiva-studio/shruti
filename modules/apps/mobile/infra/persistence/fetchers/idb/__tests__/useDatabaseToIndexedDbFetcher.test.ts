import { beforeEach, describe, expect, it, vi } from "vitest"

interface SavedBlob {
  dbName: string
  storeName: string
  key: string
  blob: Blob
}

const store = {
  saved: [] as SavedBlob[],
  deleted: [] as string[],
  /** Keys `getAllKeys` answers with, per `dbName/storeName`. */
  keys: new Map<string, string[]>(),
  /** Thrown by `getAllKeys` when set — an object store that will not open. */
  listFailure: null as Error | null,
}

vi.mock("@kit/infra", () => ({
  saveBlob: async (dbName: string, storeName: string, key: string, blob: Blob) => {
    store.saved.push({ dbName, storeName, key, blob })
  },
  keyExists: async (dbName: string, storeName: string, key: string) =>
    (store.keys.get(`${dbName}/${storeName}`) ?? []).includes(key),
  deleteBlob: async (dbName: string, storeName: string, key: string) => {
    store.deleted.push(`${dbName}/${storeName}/${key}`)
  },
  getAllKeys: async (dbName: string, storeName: string) => {
    if (store.listFailure) throw store.listFailure
    return store.keys.get(`${dbName}/${storeName}`) ?? []
  },
}))

const download =
  vi.fn<(url: string, onProgress: (received: number, total: number) => void) => Promise<Blob>>()

vi.mock("../streamDownloader.js", () => ({
  downloadWithProgress: (url: string, onProgress: (received: number, total: number) => void) =>
    download(url, onProgress),
}))

const { useDatabaseToIndexedDbFetcher } = await import("../useDatabaseToIndexedDbFetcher.js")

const PATH = "lectorium/blobs/content.db"

describe("useDatabaseToIndexedDbFetcher — download", () => {
  beforeEach(() => {
    store.saved = []
    store.deleted = []
    store.keys = new Map()
    store.listFailure = null
    download.mockReset()
    download.mockResolvedValue(new Blob(["db-bytes"]))
  })

  it("stores the downloaded blob under the db, store and key of the path", async () => {
    await useDatabaseToIndexedDbFetcher().download("https://cdn/db", PATH)

    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]).toMatchObject({
      dbName: "lectorium",
      storeName: "blobs",
      key: "content.db",
    })
    expect(await store.saved[0]!.blob.text()).toBe("db-bytes")
  })

  it("downloads from the url it was given", async () => {
    await useDatabaseToIndexedDbFetcher().download("https://cdn/content.db", PATH)

    expect(download.mock.calls[0]![0]).toBe("https://cdn/content.db")
  })

  it("reports progress while downloading and a final report that it stopped", async () => {
    download.mockImplementation(async (_url, onProgress) => {
      onProgress(50, 100)
      onProgress(100, 100)
      return new Blob(["db-bytes"])
    })
    const reports: Array<[number, number, boolean]> = []

    await useDatabaseToIndexedDbFetcher().download(
      "https://cdn/db",
      PATH,
      (received, total, busy) => reports.push([received, total, busy])
    )

    expect(reports[0]).toEqual([0, 0, true])
    expect(reports).toContainEqual([50, 100, true])
    expect(reports).toContainEqual([100, 100, true])
    expect(reports.at(-1)).toEqual([0, 0, false])
  })

  it("rejects a second download while one is still running", async () => {
    let release = (): void => {}
    download.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(new Blob(["db-bytes"]))
        })
    )
    const fetcher = useDatabaseToIndexedDbFetcher()
    const first = fetcher.download("https://cdn/db", PATH)

    await expect(fetcher.download("https://cdn/db", PATH)).rejects.toThrow(
      "Download already in progress"
    )

    release()
    await first
    expect(store.saved).toHaveLength(1)
  })

  it("stores nothing and reports the stop when the download fails", async () => {
    download.mockRejectedValue(new Error("Truncated download: received 3 of 9 bytes"))
    const reports: Array<[number, number, boolean]> = []

    await expect(
      useDatabaseToIndexedDbFetcher().download("https://cdn/db", PATH, (r, t, busy) =>
        reports.push([r, t, busy])
      )
    ).rejects.toThrow("Truncated download")

    expect(store.saved).toEqual([])
    expect(reports.at(-1)).toEqual([0, 0, false])
  })

  it("accepts a retry after a failed download", async () => {
    const fetcher = useDatabaseToIndexedDbFetcher()
    download.mockRejectedValueOnce(new Error("network down"))

    await expect(fetcher.download("https://cdn/db", PATH)).rejects.toThrow("network down")
    await fetcher.download("https://cdn/db", PATH)

    expect(store.saved).toHaveLength(1)
  })

  it("lets a second fetcher download while the first one is busy", async () => {
    let release = (): void => {}
    download.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(new Blob(["first"]))
        })
    )
    const busy = useDatabaseToIndexedDbFetcher().download("https://cdn/db", PATH)

    await useDatabaseToIndexedDbFetcher().download("https://cdn/db", "lectorium/blobs/user.db")

    release()
    await busy
    expect(store.saved.map((s) => s.key)).toEqual(["user.db", "content.db"])
  })
})

describe("useDatabaseToIndexedDbFetcher — cached blobs", () => {
  beforeEach(() => {
    store.saved = []
    store.deleted = []
    store.keys = new Map([["lectorium/blobs", ["content.db.20", "user.db"]]])
    store.listFailure = null
  })

  it("reports a cached key as present and an uncached one as absent", async () => {
    const fetcher = useDatabaseToIndexedDbFetcher()

    expect(await fetcher.exists("lectorium/blobs/user.db")).toBe(true)
    expect(await fetcher.exists("lectorium/blobs/content.db.21")).toBe(false)
  })

  it("reports absent for a store nothing was ever cached in", async () => {
    expect(await useDatabaseToIndexedDbFetcher().exists("other/blobs/user.db")).toBe(false)
  })

  it("removes the addressed key", async () => {
    await useDatabaseToIndexedDbFetcher().delete("lectorium/blobs/content.db.20")

    expect(store.deleted).toEqual(["lectorium/blobs/content.db.20"])
  })

  it("lists cached blobs as full paths the other methods accept", async () => {
    const fetcher = useDatabaseToIndexedDbFetcher()

    const paths = await fetcher.list("lectorium/blobs")

    expect(paths).toEqual(["lectorium/blobs/content.db.20", "lectorium/blobs/user.db"])
    expect(await fetcher.exists(paths[0]!)).toBe(true)
  })

  it("lists nothing for a store that holds no cached blob", async () => {
    expect(await useDatabaseToIndexedDbFetcher().list("other/blobs")).toEqual([])
  })

  it("lists nothing for a directory that names no store", async () => {
    const fetcher = useDatabaseToIndexedDbFetcher()

    expect(await fetcher.list("lectorium")).toEqual([])
    expect(await fetcher.list("")).toEqual([])
  })

  it("lists nothing rather than failing startup when the store cannot be opened", async () => {
    store.listFailure = new Error("InvalidStateError: database is closing")

    expect(await useDatabaseToIndexedDbFetcher().list("lectorium/blobs")).toEqual([])
  })
})
