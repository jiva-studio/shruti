import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createSqlOutboxRepository } from "../outboxRepository.sql.js"

/**
 * SQL-level tests for the outbox journal adapter's push-side scoping.
 *
 * Regression guard for #1497: `listPending` used to be a bare `WHERE sent = 0`,
 * so after an account deletion (which drops the domain rows but leaves the
 * journal) the previous identity's un-pushed notes and chat messages were
 * uploaded under the new anonymous one. Ownership is now a property of the row
 * (`owner_id`, 023 migration); the `pushed_outbox_id` watermark only governs
 * rows journaled before that column existed.
 */
async function createOutboxTable(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       collection TEXT NOT NULL, doc_id TEXT NOT NULL, op TEXT NOT NULL,
       data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
       created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
       owner_id TEXT
     )`
  )
}

describe("createSqlOutboxRepository — push scoping", () => {
  let db: IDatabase
  let outbox: IOutboxRepository
  /** The account journaling now; the adapter reads it per append. */
  let owner: string | null

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await createOutboxTable(db)
    owner = null
    outbox = createSqlOutboxRepository(db, () => owner)
  })

  const journal = (docId: string, collection = "notes") =>
    outbox.append({
      collection,
      docId,
      op: "upsert",
      data: { id: docId },
      hlc: "0000000000001-0000-dev",
      baseHlc: null,
    })

  const pendingFor = async (ownerId: string | null, afterId = 0) =>
    (await outbox.listPending(200, { ownerId, afterId })).map((e) => e.docId)

  it("returns every unowned unsent row when the watermark is 0", async () => {
    await journal("note-1")
    await journal("note-2")

    expect((await outbox.listPending()).map((e) => e.docId)).toEqual(["note-1", "note-2"])
  })

  it("hides a deleted account's rows from the identity that replaces it", async () => {
    // user-1 writes a note and a chat message but never gets to push them.
    owner = "user-1"
    await journal("note-a")
    await journal("msg-a", "chat_messages")

    // Account deleted; the device drops to a new anonymous identity, which
    // journals its own change. The wipe does not clear the journal.
    owner = "anon-2"
    await journal("note-b")

    expect(await pendingFor("anon-2")).toEqual(["note-b"])
    expect(await pendingFor("user-1")).toEqual(["note-a", "msg-a"])

    // user-1's rows are still on disk and still unsent — only out of scope.
    const rows = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE sent = 0")
    expect(Number(rows[0]!.n)).toBe(3)
  })

  it("keeps owned rows readable no matter how late the watermark lands", async () => {
    // The engine learns the identity changed only on its next cycle — which a
    // cycle already in flight, or a region without profile sync, can delay past
    // the new account's first writes. Stamping the tail then must not retire
    // them: ownership is on the row, not in the id range.
    owner = "user-1"
    await journal("note-a")
    owner = "anon-2"
    await journal("note-b")
    await journal("note-c")

    const lateWatermark = await outbox.latestId()
    expect(lateWatermark).toBe(3)

    expect(await pendingFor("anon-2", lateWatermark)).toEqual(["note-b", "note-c"])
  })

  it("leaves unowned rows to the watermark", async () => {
    // Pre-023 rows: attributable to nobody, so the identity change retires them.
    await journal("legacy-1")
    await journal("legacy-2")

    expect(await pendingFor("anon-2")).toEqual(["legacy-1", "legacy-2"])
    expect(await pendingFor("anon-2", await outbox.latestId())).toEqual([])
  })

  it("applies the limit after scoping, not before", async () => {
    owner = "user-1"
    await journal("note-1")
    owner = "anon-2"
    await journal("note-2")
    await journal("note-3")
    await journal("note-4")

    const pending = await outbox.listPending(2, { ownerId: "anon-2" })
    expect(pending.map((e) => e.docId)).toEqual(["note-2", "note-3"])
  })

  it("reports 0 as the latest id of an empty journal", async () => {
    expect(await outbox.latestId()).toBe(0)
  })

  it("counts sent rows in the latest id so the watermark retires them too", async () => {
    await journal("note-1")
    await journal("note-2")
    await outbox.markSent([1, 2])
    await journal("note-3")

    expect(await outbox.latestId()).toBe(3)
    expect(await pendingFor(null, 3)).toEqual([])
  })
})
