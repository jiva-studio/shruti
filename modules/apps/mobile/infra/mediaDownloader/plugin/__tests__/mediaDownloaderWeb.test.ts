// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MediaDownloaderWeb } from "../../../../../../plugins/media-downloader/src/web"

/**
 * The web backend of the downloader plugin, driven directly.
 *
 * Everything here turns on one fact about `fetch`: aborting it is a request,
 * not an outcome. A CDN that accepts the connection and goes quiet may answer
 * the abort late, or never — and it may also answer with the bytes after the
 * transfer was cancelled. The layers above (`downloadMedia`, the adapter) are
 * already covered against a rival that never settles; this is the last one
 * between them and the socket, and it is where a never-settling request used
 * to strand a task in `running` with nobody transferring (#1680 / #1682).
 *
 * `fetch` is therefore a registry of requests the test settles by hand: no
 * request answers on its own, and none reacts to its abort signal unless the
 * test says so.
 */

const FILE_KEY = "/public/tracks/t-1/audio/original.mp3"
const URL_A = `https://edge-a.test${FILE_KEY}`
const URL_B = `https://edge-b.test${FILE_KEY}`
const ID_A = `${FILE_KEY}#edge-a.test`
const ID_B = `${FILE_KEY}#edge-b.test`
const DESTINATION = { directory: "data" as const, subdir: "shruti", filename: "original.mp3" }

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

interface Request {
  signal: AbortSignal
  resolve: (response: unknown) => void
  reject: (error: unknown) => void
}

const requests = new Map<string, Request>()
let fetched: string[] = []
let cacheStore: Map<string, unknown>

/** A response that streams `BYTES` in one chunk, as a real body would. */
function bodyOf(bytes: Uint8Array): unknown {
  let sent = false
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-length" ? String(bytes.length) : null),
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
      }),
    },
  }
}

/** Answer a request with the file. */
function serve(url: string, bytes = BYTES): void {
  requests.get(url)!.resolve(bodyOf(bytes))
}

/** What a browser does when it notices the abort — which it may never do. */
function honourAbort(url: string): void {
  requests.get(url)!.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
}

/** Let every pending microtask and the plugin's own awaits run to a standstill. */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function optionsFor(id: string, url: string) {
  return { id, url, fileKey: FILE_KEY, destination: DESTINATION }
}

describe("MediaDownloaderWeb", () => {
  let plugin: MediaDownloaderWeb
  let completed: { id: string }[]
  let failed: { id: string; error: string; code?: string }[]

  beforeEach(async () => {
    requests.clear()
    fetched = []
    cacheStore = new Map()

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: { signal: AbortSignal }) => {
        fetched.push(url)
        return new Promise((resolve, reject) => {
          requests.set(url, { signal: init.signal, resolve, reject })
        })
      })
    )
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async (key: string, response: unknown) => void cacheStore.set(key, response),
        match: async (key: string) => cacheStore.get(key),
        delete: async (key: string) => cacheStore.delete(key),
      }),
    })
    let blobs = 0
    URL.createObjectURL = vi.fn(() => `blob:local/${++blobs}`)
    URL.revokeObjectURL = vi.fn()

    plugin = new MediaDownloaderWeb()
    completed = []
    failed = []
    await plugin.addListener("completed", (e) => void completed.push(e))
    await plugin.addListener("failed", (e) => void failed.push(e))
  })

  it("delivers the candidate that answers while its rival never does", async () => {
    // The hedge: both candidates are in flight for one file, edge-a accepted
    // the request and went silent. The winner must not be waiting on anything
    // of the loser's — including the cache entry they share.
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.download(optionsFor(ID_B, URL_B))

    serve(URL_B)
    await vi.waitFor(() => expect(completed).toHaveLength(1))

    expect(completed[0]!.id).toBe(ID_B)
    expect(cacheStore.has(FILE_KEY)).toBe(true)
  })

  it("settles a cancel the request never answers", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.cancel({ id: ID_A, deletePartial: true })
    // edge-a never reacts to the abort — the request stays outstanding.
    await settleAll()

    expect(failed).toEqual([{ id: ID_A, error: "cancelled", code: "cancelled" }])
    expect((await plugin.getTask({ id: ID_A })).task?.state).toBe("cancelled")
  })

  it("opens a fresh request when a cancelled download is asked for again", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.cancel({ id: ID_A, deletePartial: true })
    await settleAll()
    fetched = []
    requests.delete(URL_A)

    // The same lecture, re-added. It must not join the corpse of the first
    // attempt, which has nothing left to emit.
    await plugin.download(optionsFor(ID_A, URL_A))
    expect(fetched).toEqual([URL_A])

    serve(URL_A)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]!.id).toBe(ID_A)
  })

  it("stays silent when a cancelled request answers with the file anyway", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.cancel({ id: ID_A, deletePartial: true })
    // The abort raced the response: the bytes were already on their way.
    serve(URL_A)
    await settleAll()

    // Reporting them would undo the cancel, and would write the shared cache
    // entry under whoever is downloading this file now.
    expect(completed).toEqual([])
    expect(cacheStore.has(FILE_KEY)).toBe(false)
    expect((await plugin.getTask({ id: ID_A })).task?.state).toBe("cancelled")
    expect(failed).toHaveLength(1)
  })

  it("reports a request that answers its abort once, not twice", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.cancel({ id: ID_A, deletePartial: true })
    honourAbort(URL_A)
    await settleAll()

    expect(failed).toEqual([{ id: ID_A, error: "cancelled", code: "cancelled" }])
  })

  it("reports a genuine transport failure as a failure", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    requests.get(URL_A)!.reject(new Error("network down"))
    await vi.waitFor(() => expect(failed).toHaveLength(1))

    expect(failed[0]).toMatchObject({ id: ID_A, error: "network down" })
    expect(failed[0]!.code).toBeUndefined()
    expect((await plugin.getTask({ id: ID_A })).task?.state).toBe("failed")
  })

  it("is idempotent while the transfer is genuinely live", async () => {
    await plugin.download(optionsFor(ID_A, URL_A))
    await plugin.download(optionsFor(ID_A, URL_A))

    expect(fetched).toEqual([URL_A])
  })
})
