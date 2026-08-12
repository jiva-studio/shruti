import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase } from "../../../../repositories/sql/__tests__/testDb.js"
import { migration_013_sync_outbox } from "../013_sync_outbox.js"
import { migration_023_outbox_owner } from "../023_outbox_owner.js"
import { migration_024_outbox_collection_docid_index } from "../024_outbox_collection_docid_index.js"
import { migration_029_outbox_compaction } from "../029_outbox_compaction.js"

/**
 * One-time compaction of the journal a device already carries (#1798).
 *
 * The incremental prune on the push path only revisits the documents a batch
 * acknowledges, so the superseded rows of documents nobody writes to again are
 * this migration's job — and nothing else's.
 */
describe("migration 028 — outbox compaction", () => {
  let db: IDatabase
  let nextId: number

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await migration_013_sync_outbox.up(db)
    await migration_023_outbox_owner.up(db)
    await migration_024_outbox_collection_docid_index.up(db)
    nextId = 1
  })

  /** Journal one row; returns its id. */
  async function journal(docId: string, sent: 0 | 1, collection = "notes"): Promise<number> {
    const id = nextId++
    await db.execute(
      `INSERT INTO outbox (id, collection, doc_id, op, data, hlc, base_hlc, created_at, sent)
       VALUES (?, ?, ?, 'upsert', '{}', ?, NULL, 0, ?)`,
      [id, collection, docId, `${String(id).padStart(13, "0")}-0000-dev`, sent]
    )
    return id
  }

  async function setWatermark(id: number): Promise<void> {
    await db.execute(
      `INSERT INTO sync_state (device_id, pull_cursor, acked_seq, pushed_outbox_id, updated_at)
       VALUES ('dev-1', 0, 0, ?, 0)
       ON CONFLICT(device_id) DO UPDATE SET pushed_outbox_id = ?`,
      [id, id]
    )
  }

  const rowIds = async () =>
    (await db.query<{ id: number }>("SELECT id FROM outbox ORDER BY id")).map((r) => Number(r.id))

  it("drops the superseded acknowledged rows a device has accumulated", async () => {
    await journal("note-1", 1)
    await journal("note-1", 1)
    await journal("note-1", 1)
    await journal("note-2", 1)
    await setWatermark(4)

    await migration_029_outbox_compaction.up(db)

    // note-1 keeps its newest row, note-2 its only one; both stay pushable to
    // an account signing in on top of this journal (#1627).
    expect(await rowIds()).toEqual([3, 4])
  })

  it("keeps the journal's tail, which seeds the HLC chain", async () => {
    await journal("note-1", 1)
    const tail = await journal("note-1", 1)
    await setWatermark(tail)

    await migration_029_outbox_compaction.up(db)

    const rows = await db.query<{ hlc: string }>("SELECT hlc FROM outbox ORDER BY id DESC LIMIT 1")
    expect(await rowIds()).toEqual([tail])
    expect(rows[0]!.hlc).toBe(`${String(tail).padStart(13, "0")}-0000-dev`)
  })

  it("never touches pending rows or rows at or above the watermark", async () => {
    await journal("note-1", 1)
    await journal("note-1", 0)
    await journal("note-1", 1)
    await journal("note-1", 1)
    await setWatermark(3)

    await migration_029_outbox_compaction.up(db)

    // 1 goes (acknowledged, superseded, below the watermark); 2 is pending,
    // 3 sits at the watermark, 4 above it.
    expect(await rowIds()).toEqual([2, 3, 4])
  })

  it("prunes nothing on a device that has never pushed", async () => {
    await journal("note-1", 1)
    await journal("note-1", 1)

    await migration_029_outbox_compaction.up(db)

    expect(await rowIds()).toEqual([1, 2])
  })

  it("is idempotent — a replay after an interrupted migration is a no-op", async () => {
    await journal("note-1", 1)
    await journal("note-1", 1)
    await journal("note-1", 1)
    await setWatermark(3)

    await migration_029_outbox_compaction.up(db)
    const after = await rowIds()
    await migration_029_outbox_compaction.up(db)

    expect(await rowIds()).toEqual(after)
    expect(after).toEqual([3])
  })
})
