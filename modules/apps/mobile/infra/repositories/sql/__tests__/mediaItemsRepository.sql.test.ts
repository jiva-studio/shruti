import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase, QueryParams } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { ITransaction, IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { downloadMedia } from "@usecases/downloads/downloadMedia.js"
import { createSqlMediaItemRepository } from "../mediaItemsRepository.sql.js"
import { createReentrantUnitOfWork } from "../reentrantUnitOfWork.sql.js"
import { applyUserSchemaForTests, createInMemoryTestDatabase } from "./testDb.js"

const TRACK_A = "track-a" as TrackId
const TRACK_B = "track-b" as TrackId

const SERVER: CdnServer = {
  id: "server-a",
  name: "Server A",
  urlTemplate: "https://a.example.com/{path}",
  shareAudioUrl: "https://a.example.com/excerpts",
  shareVideoUrl: "https://a.example.com/reels",
  authBaseUrl: "https://a.example.com/auth",
  chatBaseUrl: "https://a.example.com",
}

/** Serialises `transaction()` callers through a promise chain, the way both
 *  real adapters do. `execute()` deliberately bypasses that queue in the
 *  adapters — that bypass IS #1790 — so it bypasses it here too. */
function withTxQueue(db: IDatabase): IDatabase {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    ...db,
    transaction(fn: () => Promise<void>): Promise<void> {
      const next = queue.then(() => db.transaction(fn))
      queue = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
  }
}

/** Records every statement issued OUTSIDE a `transaction()` block — i.e. every
 *  write that would be at the mercy of whatever transaction happened to be
 *  open on the shared connection. */
function withUnguardedWatch(db: IDatabase): { db: IDatabase; unguarded: string[] } {
  let depth = 0
  const unguarded: string[] = []
  return {
    db: {
      ...db,
      async execute(sql: string, params?: QueryParams): Promise<void> {
        if (depth === 0) unguarded.push(sql)
        await db.execute(sql, params)
      },
      async transaction(fn: () => Promise<void>): Promise<void> {
        depth++
        try {
          await db.transaction(fn)
        } finally {
          depth--
        }
      },
    },
    unguarded,
  }
}

describe("mediaItemsRepository.sql — writes go through the unit of work", () => {
  let watched: { db: IDatabase; unguarded: string[] }
  let repo: IMediaItemRepository

  beforeEach(async () => {
    const raw = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(raw)
    watched = withUnguardedWatch(raw)
    repo = createSqlMediaItemRepository(watched.db, createReentrantUnitOfWork(watched.db))
  })

  const writes: readonly [string, (r: IMediaItemRepository) => Promise<unknown>][] = [
    ["upsert (insert)", (r) => r.upsert(TRACK_A, "downloading", null)],
    ["upsert (update)", (r) => r.upsert(TRACK_A, "ready", "/audio/a.mp3")],
    ["markEvictPending", (r) => r.markEvictPending(TRACK_A)],
    ["deleteByTrack", (r) => r.deleteByTrack(TRACK_A)],
    ["clearAll", (r) => r.clearAll()],
    ["failStaleDownloads", (r) => r.failStaleDownloads()],
  ]

  it.each(writes)("%s issues nothing outside a transaction", async (_name, write) => {
    // Seed through the repo so the update/delete paths have a row to hit, then
    // measure only the write under test.
    await repo.upsert(TRACK_A, "downloading", null)
    watched.unguarded.length = 0
    await write(repo)
    expect(watched.unguarded).toEqual([])
  })

  it("deleteById issues nothing outside a transaction", async () => {
    const item = await repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    watched.unguarded.length = 0
    await repo.deleteById(item.id)
    expect(watched.unguarded).toEqual([])
  })

  it("still persists what it writes", async () => {
    await repo.upsert(TRACK_A, "downloading", null)
    const ready = await repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    expect(ready.state).toBe("ready")
    expect(await repo.listReady()).toHaveLength(1)

    await repo.markEvictPending(TRACK_A)
    expect((await repo.listEvictPending()).map((i) => i.trackId)).toEqual([TRACK_A])

    // A re-download settles the debt — the flag must survive the round trip
    // through the transaction, not just the in-memory return value.
    await repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    expect(await repo.listEvictPending()).toEqual([])

    await repo.upsert(TRACK_B, "downloading", null)
    const stale = await repo.failStaleDownloads()
    expect(stale.map((i) => i.trackId)).toEqual([TRACK_B])
    expect((await repo.getByTrack(TRACK_B))?.state).toBe("failed")

    await repo.deleteByTrack(TRACK_A)
    expect(await repo.getByTrack(TRACK_A)).toBeNull()

    await repo.clearAll()
    expect(await repo.listReady()).toEqual([])
  })
})

describe("mediaItemsRepository.sql — writes issued during a foreign transaction", () => {
  let queued: IDatabase
  let unitOfWork: IUnitOfWork
  let repo: IMediaItemRepository

  beforeEach(async () => {
    const raw = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(raw)
    queued = withTxQueue(raw)
    unitOfWork = createReentrantUnitOfWork(queued)
    repo = createSqlMediaItemRepository(queued, unitOfWork)
  })

  /** Opens a transaction that stays open until `release()`, then throws. Stands
   *  in for a `pullAndMerge` page — one transaction across a whole run of
   *  `applyRemote` awaits — that fails and rolls back. */
  function openFailingTransaction() {
    let open!: () => void
    let release!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const running = unitOfWork.run(async () => {
      open()
      await gate
      throw new Error("pull failed")
    })
    return { opened, release, running }
  }

  it("keeps a finished download's row out of the transaction it overlaps", async () => {
    // #1790: a transfer completes whenever the CDN says so, which is routinely
    // inside a sync pull's transaction window. As a bare `execute` the "ready"
    // row joined that transaction, reported success to the caller and vanished
    // on the rollback — leaving the row at "downloading" until the next launch.
    await repo.upsert(TRACK_A, "downloading", null)
    const { opened, release, running } = openFailingTransaction()
    await opened

    const saved = repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    release()
    await expect(running).rejects.toThrow("pull failed")
    await saved

    expect((await repo.getByTrack(TRACK_A))?.state).toBe("ready")
  })

  it("keeps a pending eviction out of the transaction it overlaps", async () => {
    await repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    const { opened, release, running } = openFailingTransaction()
    await opened

    const marked = repo.markEvictPending(TRACK_A)
    release()
    await expect(running).rejects.toThrow("pull failed")
    await marked

    expect((await repo.listEvictPending()).map((i) => i.trackId)).toEqual([TRACK_A])
  })

  it("keeps a removal out of the transaction it overlaps", async () => {
    await repo.upsert(TRACK_A, "ready", "/audio/a.mp3")
    const { opened, release, running } = openFailingTransaction()
    await opened

    const removed = repo.deleteByTrack(TRACK_A)
    release()
    await expect(running).rejects.toThrow("pull failed")
    await removed

    expect(await repo.getByTrack(TRACK_A)).toBeNull()
  })
})

describe("mediaItemsRepository.sql — a write inside the caller's transaction", () => {
  let queued: IDatabase
  let unitOfWork: IUnitOfWork
  let repo: IMediaItemRepository

  beforeEach(async () => {
    const raw = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(raw)
    queued = withTxQueue(raw)
    unitOfWork = createReentrantUnitOfWork(queued)
    repo = createSqlMediaItemRepository(queued, unitOfWork)
  })

  it("joins the transaction whose handle it is given instead of opening a second one", async () => {
    // Without the handle this waits behind the transaction it is inside, which
    // never ends — the test would hang rather than fail an assertion. It is
    // the `transaction()` queue above that makes that real; a bare in-memory
    // database would happily nest.
    const claimed = await unitOfWork.run((tx: ITransaction | undefined) =>
      repo.upsert(TRACK_A, "downloading", null, "original", tx)
    )
    expect(claimed.state).toBe("downloading")
    expect((await repo.getByTrack(TRACK_A))?.state).toBe("downloading")
  })

  it("rolls back with the transaction it joined", async () => {
    // The other half of joining: the claim is atomic WITH whatever the caller
    // decided around it, so a block that gives up leaves no half-claimed row
    // to make the next attempt read as "already-in-progress".
    await expect(
      unitOfWork.run(async (tx: ITransaction | undefined) => {
        await repo.upsert(TRACK_A, "downloading", null, "original", tx)
        throw new Error("claim abandoned")
      })
    ).rejects.toThrow("claim abandoned")

    expect(await repo.getByTrack(TRACK_A)).toBeNull()
  })

  it("lets downloadMedia claim the slot on the shared unit of work", async () => {
    // The real in-transaction caller, wired the way `createSqlAppRepositories`
    // wires it: one unit of work shared by the use case and the repository, so
    // the handle the use case is given is one the repository can recognise.
    const result = await downloadMedia(
      { trackId: TRACK_A, path: "audio/a.mp3", candidates: [SERVER] },
      { mediaItems: repo, unitOfWork, transfer: async () => "file:///cache/a.mp3" }
    )

    expect(result.ok).toBe(true)
    expect((await repo.getByTrack(TRACK_A))?.state).toBe("ready")
  })

  it("refuses a second claim while the first is still downloading", async () => {
    await repo.upsert(TRACK_A, "downloading", null)
    const result = await downloadMedia(
      { trackId: TRACK_A, path: "audio/a.mp3", candidates: [SERVER] },
      { mediaItems: repo, unitOfWork, transfer: async () => "file:///cache/a.mp3" }
    )
    expect(result).toEqual({ ok: false, error: "already-in-progress" })
  })
})
