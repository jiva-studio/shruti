import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { createSqlListeningSessionRepository } from "../../../../repositories/sql/listeningSessionsRepository.sql.js"
import {
  applyUserSchemaForTests,
  createInMemoryTestDatabase,
} from "../../../../repositories/sql/__tests__/testDb.js"
import { migration_027_playlist_items_unique_track } from "../027_playlist_items_unique_track.js"

interface ItemRow {
  id: string
  track_id: string
  added_at: number
  archived_at: number | null
  collection_id: string | null
}

async function addItem(db: IDatabase, row: ItemRow): Promise<void> {
  await db.execute(
    `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id)
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.track_id, row.added_at, row.archived_at, row.collection_id]
  )
}

async function addSession(db: IDatabase, id: string, itemId: string, to: number): Promise<void> {
  await db.execute(
    `INSERT INTO listening_sessions
       (id, item_id, started_at, ended_at, from_position, to_position)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [id, itemId, to, to, to]
  )
}

async function items(db: IDatabase): Promise<ItemRow[]> {
  return db.query<ItemRow>(
    `SELECT id, track_id, added_at, archived_at, collection_id
       FROM playlist_items ORDER BY track_id, id`
  )
}

async function sessionItemIds(db: IDatabase): Promise<Record<string, string>> {
  const rows = await db.query<{ id: string; item_id: string }>(
    "SELECT id, item_id FROM listening_sessions ORDER BY id"
  )
  return Object.fromEntries(rows.map((r) => [r.id, r.item_id]))
}

describe("migration 027 — one playlist_items row per track_id", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    // Pre-027 shape: no unique index, so the duplicates real devices carry
    // can be seeded.
    await applyUserSchemaForTests(db)
  })

  it("folds an archived shadow into the live row and CARRIES ITS SESSIONS OVER", async () => {
    // The state from #1736: queued, finished (auto-archived), re-queued.
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: 100,
      archived_at: 150,
      collection_id: "col-9",
    })
    await addItem(db, {
      id: "pl_2",
      track_id: "trk",
      added_at: 200,
      archived_at: null,
      collection_id: null,
    })
    // Progress on BOTH rows — the archived one holds the first listen, which
    // is exactly what a naive fold would throw away.
    await addSession(db, "ls_old", "pl_1", 1200)
    await addSession(db, "ls_new", "pl_2", 300)

    await migration_027_playlist_items_unique_track.up(db)

    // One row left: the newest add, active (add-wins — the add is newer than
    // the archive), keeping the provenance the older row carried.
    expect(await items(db)).toEqual([
      { id: "pl_2", track_id: "trk", added_at: 200, archived_at: null, collection_id: "col-9" },
    ])
    // Nothing was dropped: both sessions now key onto the surviving row, so
    // the resume high-water mark is the real 1200, not 300.
    expect(await sessionItemIds(db)).toEqual({ ls_new: "pl_2", ls_old: "pl_2" })
    const [hwm] = await db.query<{ hwm: number }>(
      "SELECT MAX(to_position) AS hwm FROM listening_sessions WHERE item_id = 'pl_2'"
    )
    expect(hwm?.hwm).toBe(1200)
  })

  it("keeps the item archived when the newest archive is newer than the newest add", async () => {
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: 100,
      archived_at: null,
      collection_id: null,
    })
    await addItem(db, {
      id: "pl_2",
      track_id: "trk",
      added_at: 200,
      archived_at: 900,
      collection_id: null,
    })

    await migration_027_playlist_items_unique_track.up(db)

    expect(await items(db)).toEqual([
      { id: "pl_2", track_id: "trk", added_at: 200, archived_at: 900, collection_id: null },
    ])
  })

  it("leaves an already-unique table alone and enforces uniqueness afterwards", async () => {
    await addItem(db, {
      id: "pl_a",
      track_id: "trk-a",
      added_at: 1,
      archived_at: null,
      collection_id: null,
    })
    await addItem(db, {
      id: "pl_b",
      track_id: "trk-b",
      added_at: 2,
      archived_at: 5,
      collection_id: "col-1",
    })

    await migration_027_playlist_items_unique_track.up(db)

    expect(await items(db)).toEqual([
      { id: "pl_a", track_id: "trk-a", added_at: 1, archived_at: null, collection_id: null },
      { id: "pl_b", track_id: "trk-b", added_at: 2, archived_at: 5, collection_id: "col-1" },
    ])
    // The invariant is now the database's, not a convention.
    await expect(
      addItem(db, {
        id: "pl_c",
        track_id: "trk-a",
        added_at: 3,
        archived_at: null,
        collection_id: null,
      })
    ).rejects.toThrow()
  })

  it("is a no-op on re-run (a replay must not throw or re-fold)", async () => {
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: 100,
      archived_at: 150,
      collection_id: null,
    })
    await addItem(db, {
      id: "pl_2",
      track_id: "trk",
      added_at: 200,
      archived_at: null,
      collection_id: null,
    })
    await addSession(db, "ls_old", "pl_1", 1200)

    await migration_027_playlist_items_unique_track.up(db)
    const after = await items(db)
    const afterSessions = await sessionItemIds(db)

    await expect(migration_027_playlist_items_unique_track.up(db)).resolves.toBeUndefined()

    expect(await items(db)).toEqual(after)
    expect(await sessionItemIds(db)).toEqual(afterSessions)
  })

  it("breaks an added_at tie deterministically instead of leaving both rows", async () => {
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: 100,
      archived_at: 90,
      collection_id: null,
    })
    await addItem(db, {
      id: "pl_2",
      track_id: "trk",
      added_at: 100,
      archived_at: null,
      collection_id: null,
    })

    await migration_027_playlist_items_unique_track.up(db)

    // Highest id wins the tie — the same `added_at DESC, id DESC` pick every
    // `track_id` lookup now makes.
    expect((await items(db)).map((r) => r.id)).toEqual(["pl_2"])
  })

  it("falls back to a plain index rather than aborting the migration chain", async () => {
    // One throw here would permanently abort every LATER migration and
    // `startup.ts` swallows the error, so a unique index that cannot be built
    // must degrade, not fail.
    const failing: IDatabase = {
      ...db,
      execute: async (sql, params) => {
        if (sql.includes("UNIQUE INDEX")) throw new Error("UNIQUE constraint failed")
        await db.execute(sql, params)
      },
    }
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: 1,
      archived_at: null,
      collection_id: null,
    })

    await expect(migration_027_playlist_items_unique_track.up(failing)).resolves.toBeUndefined()

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'playlist_items'"
    )
    expect(indexes.map((i) => i.name)).toContain("idx_playlist_items_track_scan")
  })

  it("does not hand the survivor the shadow's completed badge", async () => {
    // The fold carries the old pass's sessions over, but the survivor's
    // `added_at` is the newest add — so per-item progress, which is scoped to
    // the current pass, still reads the re-queued lecture as fresh.
    const addedAt = Date.now()
    await addItem(db, {
      id: "pl_1",
      track_id: "trk",
      added_at: addedAt - 7_200_000,
      archived_at: addedAt - 3_600_000,
      collection_id: null,
    })
    await addItem(db, {
      id: "pl_2",
      track_id: "trk",
      added_at: addedAt,
      archived_at: null,
      collection_id: null,
    })
    // A full listen on the shadow, an hour and a half before the re-add.
    const endedAt = Math.floor((addedAt - 5_400_000) / 1000)
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_old', 'pl_1', ?, ?, 0, 1800)`,
      [endedAt - 1800, endedAt]
    )

    await migration_027_playlist_items_unique_track.up(db)

    const sessions = createSqlListeningSessionRepository(db, {
      run: <T>(fn: () => Promise<T>) => fn(),
    })
    const id = "pl_2" as PlaylistItemId
    const durations = new Map([[id, 1800]])
    // Fresh pass…
    expect(await sessions.getResumePositionForItem(id)).toBeNull()
    expect((await sessions.getCompletedAtForItems([id], durations)).get(id) ?? null).toBeNull()
    // …but the listen was preserved, so the lifetime badge still stands.
    expect(await sessions.listEverCompletedItems([id], durations)).toContain(id)
  })
})
