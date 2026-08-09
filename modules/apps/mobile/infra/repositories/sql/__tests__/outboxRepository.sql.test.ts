import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createSqlOutboxRepository } from "../outboxRepository.sql.js"

/**
 * SQL-level tests for the outbox journal adapter, focused on the watermark
 * that `listPending` reads above.
 *
 * Regression guard for #1497: `listPending` used to be a bare `WHERE sent = 0`,
 * so after an account deletion (which drops the domain rows but leaves the
 * journal) the previous identity's un-pushed notes and chat messages were
 * uploaded under the new anonymous one.
 */
async function createOutboxTable(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       collection TEXT NOT NULL, doc_id TEXT NOT NULL, op TEXT NOT NULL,
       data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
       created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0
     )`
  )
}

describe("createSqlOutboxRepository — identity watermark", () => {
  let db: IDatabase
  let outbox: IOutboxRepository

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await createOutboxTable(db)
    outbox = createSqlOutboxRepository(db)
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

  it("returns every unsent row when the watermark is 0", async () => {
    await journal("note-1")
    await journal("note-2")

    expect((await outbox.listPending()).map((e) => e.docId)).toEqual(["note-1", "note-2"])
  })

  it("hides rows journaled under the previous identity, keeps the ones after", async () => {
    // Account A writes a note and a chat message but never gets to push them.
    await journal("note-a")
    await journal("msg-a", "chat_messages")

    // Account deleted → the engine's owner guard stamps the journal's tail as
    // the watermark. The rows themselves survive (the wipe does not clear them).
    const watermark = await outbox.latestId()
    expect(watermark).toBe(2)

    // The new anonymous identity journals its own change.
    await journal("note-b")

    const pending = await outbox.listPending(200, watermark)
    expect(pending.map((e) => e.docId)).toEqual(["note-b"])

    // A's rows are still on disk and still unsent — only unreadable for push.
    const rows = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE sent = 0")
    expect(Number(rows[0]!.n)).toBe(3)
  })

  it("applies the limit above the watermark, not before it", async () => {
    await journal("note-1")
    await journal("note-2")
    await journal("note-3")
    await journal("note-4")

    expect((await outbox.listPending(2, 2)).map((e) => e.docId)).toEqual(["note-3", "note-4"])
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
    expect(await outbox.listPending(200, 3)).toHaveLength(0)
  })
})
