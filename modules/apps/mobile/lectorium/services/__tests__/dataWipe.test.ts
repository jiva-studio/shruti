import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ISyncClient, PushRequest, PushResponse } from "@lib/contracts"
import type { IDatabase } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import { runMigrations } from "@kit/persistence"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"
import { pushLocal } from "@usecases/sync/pushLocal.js"
import type { Lectorium } from "../../lectorium.js"
import { DEFAULT_APP_CONFIG } from "../app.config.js"
import { wipeLocalUserData } from "../dataWipe.js"

/**
 * Integration test for the wipe over the REAL user-DB schema and repository
 * bundle (journal decorator included). Covers #1496: the wipe has to take the
 * personal library and the sync journal with it, or it leaves the device
 * showing removed items and pushing changes for rows that no longer exist.
 */

const OWNER = "user-1"

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

describe("wipeLocalUserData", () => {
  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
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
})
