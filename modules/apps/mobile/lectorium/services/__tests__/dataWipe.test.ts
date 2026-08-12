import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ISyncClient, PushRequest, PushResponse } from "@lib/contracts"
import type { IDatabase } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import { runMigrations } from "@kit/persistence"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"
import {
  createPersistingTestDatabase,
  type PersistingTestDatabase,
} from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"
import { useDatabaseToIndexedDbFetcher } from "@infra/persistence/fetchers/idb/index.js"
import { pushLocal } from "@usecases/sync/pushLocal.js"
import type { Lectorium } from "../../lectorium.js"
import { DEFAULT_APP_CONFIG } from "../app.config.js"
import { wipeLocalUserData } from "../dataWipe.js"

/**
 * Integration test for the wipe over the REAL user-DB schema and repository
 * bundle (journal decorator included). Covers #1496: the wipe has to take the
 * personal library and the sync journal with it, or it leaves the device
 * showing removed items and pushing changes for rows that no longer exist.
 *
 * The database is the web adapter over an export sink (#1631), so "the wipe
 * cleared it" is asserted against the image a reload would find — the wipe's
 * last SQL write is a raw-`execute` transaction, and on the web build that used
 * to commit in memory and never reach IndexedDB.
 */

const OWNER = "user-1"

/**
 * IndexedDB stand-in for the web build's blob store, keyed `dbName/storeName`.
 * Only the four entry points the web database fetcher uses are replaced; the
 * rest of `@kit/infra` stays real (`ports/app` re-exports values from it).
 */
const idb = vi.hoisted(() => new Map<string, Map<string, Uint8Array>>())

vi.mock("@kit/infra", async (importOriginal) => {
  const store = (dbName: string, storeName: string): Map<string, Uint8Array> => {
    const key = `${dbName}/${storeName}`
    let bucket = idb.get(key)
    if (!bucket) idb.set(key, (bucket = new Map()))
    return bucket
  }
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getAllKeys: async (d: string, s: string) => [...store(d, s).keys()],
    keyExists: async (d: string, s: string, k: string) => store(d, s).has(k),
    deleteBlob: async (d: string, s: string, k: string) => {
      store(d, s).delete(k)
    },
  }
})

let store: PersistingTestDatabase
let db: IDatabase
let repos: SqlAppRepositories
let app: Lectorium
let stopped: number
let refreshed: string[]
let deletedDbPaths: string[]

vi.mock("../../stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({
    open: true,
    stop: async () => {
      stopped++
    },
  }),
}))
vi.mock("../../stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    refresh: async () => {
      refreshed.push("playlist")
    },
  }),
}))
vi.mock("../../stores/useNotesStore.js", () => ({
  useNotesStore: () => ({
    refresh: async () => {
      refreshed.push("notes")
    },
  }),
}))
vi.mock("../../stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({
    refresh: async () => {
      refreshed.push("library")
    },
  }),
}))
vi.mock("../../stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({ reset: () => undefined }),
}))
vi.mock("../../stores/useIngestPollingStore.js", () => ({
  useIngestPollingStore: () => ({
    reset: () => {
      refreshed.push("ingestPolling")
    },
  }),
}))
vi.mock("../../stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({ reset: () => undefined }),
}))
vi.mock("../../stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => ({ reset: () => undefined }),
}))
vi.mock("../../stores/useChatStore.js", () => ({
  useChatStore: () => ({ clearAll: async () => undefined }),
}))

/** Records every request; never applies anything. */
class RecordingSyncClient implements ISyncClient {
  pushRequests: PushRequest[] = []
  pull = async () => ({ changes: [], cursor: 0, has_more: false })
  push = async (req: PushRequest): Promise<PushResponse> => {
    this.pushRequests.push(req)
    return { applied: [], conflicts: [] }
  }
  ackCursor = async (): Promise<void> => undefined
}

async function seedLibraryItem(id: string, title: string): Promise<void> {
  await db.execute(
    `INSERT INTO library_items (id, track_id, status, title_raw, created_at, updated_at)
     VALUES (?, ?, 'ready', ?, ?, ?)`,
    [id, `tr_${id}`, title, 1_784_000_000_000, 1_784_000_000_000]
  )
}

/** The shelf as "My library" derives it: every item minus the archived ones,
 *  because a membership row exists only once the user acts (absence = active). */
async function shelf(): Promise<string[]> {
  const items = await repos.libraryItems.listAll()
  const archived = await repos.libraryMemberships.listArchivedIds()
  return items.filter((i) => !archived.has(i.id)).map((i) => i.id)
}

async function countRows(table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

/** Row count in the persisted image — what survives a reload. */
async function countPersistedRows(table: string): Promise<number> {
  const reloaded = await store.reload()
  try {
    const rows = await reloaded.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)
    return Number(rows[0]!.n)
  } finally {
    await reloaded.close()
  }
}

describe("wipeLocalUserData", () => {
  beforeEach(async () => {
    store = await createPersistingTestDatabase()
    db = store.db
    await runMigrations(db, userMigrations)
    repos = createSqlAppRepositories({
      contentDb: db,
      userDb: db,
      getActiveLanguage: () => "en",
      getDeviceId: async () => "dev-1",
      getOwnerId: () => OWNER,
    })
    stopped = 0
    refreshed = []
    deletedDbPaths = []
    idb.clear()
    app = {
      appConfig: DEFAULT_APP_CONFIG,
      repositories: () => repos,
      filesStorage: { clearAll: async () => undefined },
      databaseFetcher: {
        list: async () => ["lectorium.7.db", "lectorium.42.db", "user.db"],
        delete: async (path: string) => {
          deletedDbPaths.push(path)
        },
      },
      preferences: {
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
      },
    } as unknown as Lectorium

    // Two library items; the user removed the second one.
    await seedLibraryItem("li-keep", "Kept lecture")
    await seedLibraryItem("li-removed", "Removed lecture")
    await repos.libraryMemberships.setArchived("li-removed")
    // A note + a playlist item, so the outbox holds ordinary pending work too.
    await repos.notes.create({
      trackId: "tr_1" as TrackId,
      text: "note",
      timeStart: 0,
      timeEnd: 1,
    })
    // Server bookkeeping the engine would have written.
    await repos.syncApply!.recordServerHlc("notes", "n-remote", "1|0|dev-2")
    await repos.syncState!.setPullCursor(42)
    await repos.syncState!.setAckedSeq(42)
    // The seeded state is what a reload would find, so the wipe is measured
    // against a durable image rather than an empty one.
    await db.save()
  })

  it("takes the personal library with it, so removed items cannot come back", async () => {
    expect(await shelf()).toEqual(["li-keep"])

    await wipeLocalUserData(app)

    // Both halves are gone. Clearing memberships alone would have republished
    // `li-removed` — absence of a membership row means ACTIVE.
    expect(await repos.libraryItems.listAll()).toEqual([])
    expect(await repos.libraryMemberships.listArchivedIds()).toEqual(new Set())
    expect(await shelf()).toEqual([])
    expect(stopped).toBe(1)
    expect(refreshed).toContain("library")
    // …and the live ingest poll is retired with it: it may be mid-request for
    // one of the rows just deleted, and its answer must not be written back.
    expect(refreshed).toContain("ingestPolling")
  })

  it("clears the sync journal so nothing stale pushes on the next cycle", async () => {
    expect(await countRows("outbox")).toBeGreaterThan(0)
    expect(await countRows("sync_doc_hlc")).toBe(1)

    await wipeLocalUserData(app)

    expect(await countRows("outbox")).toBe(0)
    expect(await countRows("sync_doc_hlc")).toBe(0)

    const gateway = new RecordingSyncClient()
    const result = await pushLocal({
      gateway,
      outbox: repos.syncOutbox!,
      apply: repos.syncApply!,
      syncState: repos.syncState!,
      unitOfWork: repos.unitOfWork,
      ownerId: OWNER,
    })

    expect(gateway.pushRequests).toEqual([])
    expect(result.pushed).toBe(0)
  })

  it("clears the journal DURABLY, so a reload cannot resurrect the deleted docs", async () => {
    expect(await countPersistedRows("outbox")).toBeGreaterThan(0)
    expect(await countPersistedRows("sync_doc_hlc")).toBe(1)

    await wipeLocalUserData(app)

    // The journal clear is the wipe's LAST SQL write and it goes through raw
    // `execute` inside one transaction. On web that used to commit in memory
    // only: the next launch reopened an image still holding the full outbox and
    // pushed it, re-creating server-side everything the user just deleted.
    expect(await countPersistedRows("outbox")).toBe(0)
    expect(await countPersistedRows("sync_doc_hlc")).toBe(0)
  })

  it("leaves the pull cursor alone — rewinding it would re-pull the wiped data", async () => {
    await wipeLocalUserData(app)

    expect(await repos.syncState!.getPullCursor()).toBe(42)
    expect(await repos.syncState!.getAckedSeq()).toBe(42)
  })

  it("keeps journaling above the watermark after the outbox is emptied", async () => {
    await wipeLocalUserData(app)

    // `outbox.id` is AUTOINCREMENT, so the delete does not rewind the sequence
    // and a post-wipe change still lands above `pushed_outbox_id`.
    await repos.notes.create({
      trackId: "tr_2" as TrackId,
      text: "after the wipe",
      timeStart: 0,
      timeEnd: 1,
    })
    const pending = await repos.syncOutbox!.listPending(undefined, {
      ownerId: OWNER,
      afterId: await repos.syncState!.getPushedOutboxId(),
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.collection).toBe("notes")
  })

  it("deletes the content catalog but not the user DB file (#1630)", async () => {
    await wipeLocalUserData(app)

    expect(deletedDbPaths).toEqual([
      "lectorium/databases/lectorium.7.db",
      "lectorium/databases/lectorium.42.db",
    ])
    // `user.db` is wiped row-by-row; dropping the file would rewind the pull
    // cursor the test above pins.
    expect(deletedDbPaths).not.toContain("lectorium/databases/user.db")
  })

  it("spares the catalog when asked, and still takes every user row (#1773)", async () => {
    // The sign-out wipe. The catalog is public content, byte-identical for
    // every user and holding nothing per-user (the personal library is
    // `library_items`, in the USER db), so dropping it buys the departing user
    // no privacy and bills the next one a ~54 MB re-download. Both halves are
    // pinned here: the user's rows go, the catalog stays.
    await wipeLocalUserData(app, { contentCatalog: "keep" })

    expect(deletedDbPaths).toEqual([])
    expect(await countPersistedRows("notes")).toBe(0)
    expect(await countPersistedRows("playlist_items")).toBe(0)
    expect(await countPersistedRows("library_items")).toBe(0)
    expect(await countPersistedRows("library_memberships")).toBe(0)
    expect(await countPersistedRows("listening_sessions")).toBe(0)
    expect(await countPersistedRows("outbox")).toBe(0)
  })

  it("deletes the catalog on the WEB build too, where nothing could list it", async () => {
    // The fetcher above is a stub whose `list()` answers — which is exactly why
    // this went unnoticed: the real web adapter's `list()` was `async () => []`,
    // so `resetContentDatabase` swept nothing and every published catalog left
    // another ~54 MB copy in IndexedDB, surviving both "Delete database" and
    // account deletion (#1663). Run the wipe over the REAL web fetcher.
    const blobs = new Map<string, Uint8Array>([
      ["lectorium.7.db", new Uint8Array([1])],
      ["lectorium.42.db", new Uint8Array([2])],
      ["user.db", new Uint8Array([3])],
    ])
    idb.set("lectorium/databases", blobs)
    const webApp = { ...app, databaseFetcher: useDatabaseToIndexedDbFetcher() } as Lectorium

    await wipeLocalUserData(webApp)

    // Only the versioned catalog blobs go; the user DB file stays (its rows
    // were wiped above, and dropping it would rewind the pull cursor).
    expect([...blobs.keys()]).toEqual(["user.db"])
    // …and the row wipe itself is durable, not just committed in memory.
    expect(await countPersistedRows("notes")).toBe(0)
    expect(await countPersistedRows("library_items")).toBe(0)
  })
})
