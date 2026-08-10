import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase } from "../../../../repositories/sql/__tests__/testDb.js"
import { migration_013_sync_outbox } from "../013_sync_outbox.js"
import { migration_014_sync_doc_hlc } from "../014_sync_doc_hlc.js"
import { migration_024_outbox_collection_docid_index } from "../024_outbox_collection_docid_index.js"

/** The exact predicate `wasJournaled` runs before every tombstone / re-journal. */
const PROBE = "SELECT 1 FROM outbox WHERE collection = ? AND doc_id = ? LIMIT 1"

async function plan(db: IDatabase, sql: string): Promise<string> {
  const rows = await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
  return rows.map((r) => r.detail).join(" | ")
}

describe("migration 024 — outbox (collection, doc_id) lookup index", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await migration_013_sync_outbox.up(db)
    await migration_014_sync_doc_hlc.up(db)
  })

  it("turns the wasJournaled probe from a full scan into an index lookup", async () => {
    expect(await plan(db, PROBE)).toContain("SCAN")

    await migration_024_outbox_collection_docid_index.up(db)

    const after = await plan(db, PROBE)
    expect(after).toContain("idx_outbox_collection_doc")
    expect(after).not.toContain("SCAN outbox")
  })

  it("serves the deleteBySession id lookup without scanning the outbox per message", async () => {
    await migration_024_outbox_collection_docid_index.up(db)
    const after = await plan(
      db,
      `SELECT doc_id FROM outbox WHERE collection = ?
       UNION
       SELECT doc_id FROM sync_doc_hlc WHERE collection = ?`
    )
    expect(after).toContain("idx_outbox_collection_doc")
    // sync_doc_hlc needs no companion index — its PRIMARY KEY
    // (collection, doc_id) already is one.
    expect(after).not.toContain("SCAN sync_doc_hlc")
  })

  it("is idempotent — a replay after an interrupted migration is a no-op", async () => {
    await migration_024_outbox_collection_docid_index.up(db)
    await migration_024_outbox_collection_docid_index.up(db)

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox'"
    )
    expect(indexes.filter((i) => i.name === "idx_outbox_collection_doc")).toHaveLength(1)
    // The pending-scan index the engine relies on is untouched.
    expect(indexes.map((i) => i.name)).toContain("idx_outbox_pending")
  })
})
