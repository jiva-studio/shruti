import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import {
  applyUserSchemaForTests,
  createInMemoryTestDatabase,
} from "../../../../repositories/sql/__tests__/testDb.js"
import { migration_016_listening_sessions_dedupe_storm } from "../016_listening_sessions_dedupe_storm.js"

interface Row {
  id: string
  itemId: string
  startedAt: number
  endedAt: number
  fromPosition: number
  toPosition: number
}

async function insert(db: IDatabase, r: Row): Promise<void> {
  await db.execute(
    `INSERT INTO listening_sessions
       (id, item_id, started_at, ended_at, from_position, to_position)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [r.id, r.itemId, r.startedAt, r.endedAt, r.fromPosition, r.toPosition]
  )
}

function total(rows: { fromPosition: number; toPosition: number }[]): number {
  return rows.reduce((acc, r) => acc + Math.max(0, r.toPosition - r.fromPosition), 0)
}

async function readAll(db: IDatabase): Promise<Row[]> {
  return db.query<Row>(
    `SELECT id, item_id AS itemId, started_at AS startedAt, ended_at AS endedAt,
            from_position AS fromPosition, to_position AS toPosition
       FROM listening_sessions ORDER BY id`
  )
}

describe("migration 016 — dedupe listening-session storm", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
  })

  it("deletes the never-finished phantom burst and collapses the total to reality", async () => {
    const T = 1_784_269_482 // the storm's shared started_at second

    // Two genuine forward sessions before the storm (distinct seconds).
    await insert(db, {
      id: "ls_a",
      itemId: "itemX",
      startedAt: T - 3600,
      endedAt: T - 3000,
      fromPosition: 0,
      toPosition: 583,
    })
    await insert(db, {
      id: "ls_b",
      itemId: "itemX",
      startedAt: T - 3000,
      endedAt: T - 2000,
      fromPosition: 571,
      toPosition: 1734,
    })

    // The storm: 300 phantom rows, same (item, started_at) second, never
    // finished (started_at == ended_at), overlapping from a pinned 643.
    for (let i = 0; i < 300; i++) {
      await insert(db, {
        id: `ls_storm_${String(i).padStart(4, "0")}`,
        itemId: "itemX",
        startedAt: T,
        endedAt: T, // never finished
        fromPosition: 643,
        toPosition: 1737 + i * 5,
      })
    }

    const before = await readAll(db)
    expect(before).toHaveLength(302)
    expect(total(before)).toBeGreaterThan(300_000) // wildly inflated (~180h-scale)

    await migration_016_listening_sessions_dedupe_storm.up(db)

    const after = await readAll(db)
    // Only the two genuine sessions survive; all 300 phantoms are gone.
    expect(after.map((r) => r.id)).toEqual(["ls_a", "ls_b"])
    expect(total(after)).toBe(583 + (1734 - 571))
  })

  it("SYNC-SAFE: a finished (already-synced) row inside the storm second is preserved", async () => {
    const T = 1_784_269_482

    // One finished row at the storm second (ended_at > started_at) — this is
    // the kind that journaled & synced to the server; it must NOT be deleted.
    await insert(db, {
      id: "ls_synced",
      itemId: "itemX",
      startedAt: T,
      endedAt: T + 120,
      fromPosition: 100,
      toPosition: 900,
    })
    // ...surrounded by never-finished phantoms in the same second.
    for (let i = 0; i < 5; i++) {
      await insert(db, {
        id: `ls_phantom_${i}`,
        itemId: "itemX",
        startedAt: T,
        endedAt: T,
        fromPosition: 643,
        toPosition: 1737 + i,
      })
    }

    await migration_016_listening_sessions_dedupe_storm.up(db)

    const after = await readAll(db)
    expect(after.map((r) => r.id)).toEqual(["ls_synced"])
  })

  it("leaves normal usage untouched (no oversized same-instant groups)", async () => {
    // Includes a legit pair sharing a second (e.g. a seek within one second):
    // count == 2 is below the storm threshold, so nothing is removed.
    await insert(db, {
      id: "ls_1",
      itemId: "itemA",
      startedAt: 1000,
      endedAt: 1600,
      fromPosition: 0,
      toPosition: 600,
    })
    await insert(db, {
      id: "ls_2",
      itemId: "itemA",
      startedAt: 1600,
      endedAt: 1600,
      fromPosition: 600,
      toPosition: 600,
    })
    await insert(db, {
      id: "ls_3",
      itemId: "itemB",
      startedAt: 2000,
      endedAt: 2600,
      fromPosition: 0,
      toPosition: 600,
    })
    await insert(db, {
      id: "ls_seek_a",
      itemId: "itemB",
      startedAt: 3000,
      endedAt: 3000,
      fromPosition: 600,
      toPosition: 600,
    })
    await insert(db, {
      id: "ls_seek_b",
      itemId: "itemB",
      startedAt: 3000,
      endedAt: 3050,
      fromPosition: 200,
      toPosition: 400,
    })

    const before = await readAll(db)
    await migration_016_listening_sessions_dedupe_storm.up(db)
    const after = await readAll(db)

    expect(after).toEqual(before)
  })
})
