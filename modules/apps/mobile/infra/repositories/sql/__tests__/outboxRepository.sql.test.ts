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

  /**
   * Compaction (#1798). The journal used to be append-only for the life of the
   * install, so what these pin is the boundary: a `sent` row goes only once a
   * NEWER row for its document has been acknowledged too, which is what leaves
   * the HLC seed, the watermark anchor and the handover's replay intact.
   */
  describe("prune (#1798)", () => {
    /** Wire HLC with an explicit physical time, so the chain is observable. */
    const stamp = (physical: number) => `${String(physical).padStart(13, "0")}-0000-dev`

    const journalAt = (docId: string, physical: number, collection = "notes") =>
      outbox.append({
        collection,
        docId,
        op: "upsert",
        data: { id: docId },
        hlc: stamp(physical),
        baseHlc: null,
      })

    const rowIds = async () =>
      (await db.query<{ id: number }>("SELECT id FROM outbox ORDER BY id")).map((r) => Number(r.id))

    const notes = (...docIds: string[]) => docIds.map((docId) => ({ collection: "notes", docId }))

    it("drops the acknowledged revisions a newer row supersedes", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-1", 3)
      await outbox.markSent([1, 2, 3])

      await outbox.prune({ watermark: 3, docs: notes("note-1") })

      expect(await rowIds()).toEqual([3])
    })

    it("never removes a row at or above the watermark", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-1", 3)
      await outbox.markSent([1, 2, 3])

      // Row 2 is superseded by row 3, but the engine has not retired it yet.
      await outbox.prune({ watermark: 2, docs: notes("note-1") })

      expect(await rowIds()).toEqual([2, 3])
    })

    it("keeps the newest row of every document", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-2", 3)
      await journalAt("note-3", 4)
      await outbox.markSent([1, 2, 3, 4])

      await outbox.prune({ watermark: 4, docs: notes("note-1", "note-2", "note-3") })

      // 1 superseded; 2 is note-1's newest, 3 is note-2's only row, 4 is the
      // tail — a document never loses its last row.
      expect(await rowIds()).toEqual([2, 3, 4])
    })

    it("preserves the seed of the HLC chain and the watermark anchor", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-1", 9)
      await outbox.markSent([1, 2, 3])

      await outbox.prune({ watermark: 3, docs: notes("note-1") })

      expect(await outbox.latestHlc()).toBe(stamp(9))
      expect(await outbox.latestId()).toBe(3)
    })

    it("leaves pending rows alone", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-1", 3)
      await journalAt("note-2", 4)
      // Row 2 never made it to the server.
      await outbox.markSent([1, 3, 4])

      await outbox.prune({ watermark: 4, docs: notes("note-1", "note-2") })

      expect(await rowIds()).toEqual([2, 3, 4])
    })

    it("only touches the documents it was given", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-2", 3)
      await journalAt("note-2", 4)
      await journalAt("note-3", 5)
      await outbox.markSent([1, 2, 3, 4, 5])

      await outbox.prune({ watermark: 5, docs: notes("note-1") })

      expect(await rowIds()).toEqual([2, 3, 4, 5])
    })

    it("is idempotent, and a no-op without a watermark or documents", async () => {
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-1", 3)
      await outbox.markSent([1, 2, 3])

      await outbox.prune({ watermark: 0, docs: notes("note-1") })
      await outbox.prune({ watermark: 3, docs: [] })
      expect(await rowIds()).toEqual([1, 2, 3])

      await outbox.prune({ watermark: 3, docs: notes("note-1") })
      const once = await rowIds()
      await outbox.prune({ watermark: 3, docs: notes("note-1") })
      await outbox.prune({ watermark: 3, docs: notes("note-1") })

      expect(await rowIds()).toEqual(once)
      expect(once).toEqual([3])
    })

    it("still hands every compacted document over to the account signing in", async () => {
      // The reason the newest row stays: `reattribute` replays the journal for
      // the new owner, and a document with no row left would never be replayed
      // — it would strand on the anonymous account (#1627).
      owner = "anon-1"
      await journalAt("note-1", 1)
      await journalAt("note-1", 2)
      await journalAt("note-2", 3)
      await journalAt("note-3", 4)
      await outbox.markSent([1, 2, 3, 4])
      await outbox.prune({ watermark: 4, docs: notes("note-1", "note-2", "note-3") })

      const refs = await outbox.reattribute({
        fromOwnerId: "anon-1",
        toOwnerId: "user-b",
        unownedAfterId: 0,
      })

      expect(refs).toEqual([
        { collection: "notes", docId: "note-1" },
        { collection: "notes", docId: "note-2" },
        { collection: "notes", docId: "note-3" },
      ])
      // One replay per document instead of one per revision — the newest, so
      // the server converges on the same master.
      expect(await pendingFor("user-b")).toEqual(["note-1", "note-2", "note-3"])
    })
  })

  describe("reattribute (#1627)", () => {
    it("re-opens the anonymous account's uploaded history for the new owner", async () => {
      owner = "anon-1"
      await journal("note-1")
      await journal("note-2")
      await outbox.markSent([1, 2])

      const refs = await outbox.reattribute({
        fromOwnerId: "anon-1",
        toOwnerId: "user-b",
        unownedAfterId: 0,
      })

      expect(refs).toEqual([
        { collection: "notes", docId: "note-1" },
        { collection: "notes", docId: "note-2" },
      ])
      expect(await pendingFor("user-b")).toEqual(["note-1", "note-2"])
    })

    it("stamps an empty base so the push cannot fast-forward the new account", async () => {
      owner = "anon-1"
      await journal("note-1")

      await outbox.reattribute({ fromOwnerId: "anon-1", toOwnerId: "user-b", unownedAfterId: 0 })

      const [row] = await outbox.listPending(200, { ownerId: "user-b" })
      expect(row!.baseHlc).toBe("")
    })

    it("takes unstamped rows above the retired floor and leaves the rest", async () => {
      owner = null
      await journal("note-1")
      await journal("note-2")

      const refs = await outbox.reattribute({
        fromOwnerId: "anon-1",
        toOwnerId: "user-b",
        unownedAfterId: 1,
      })

      expect(refs).toEqual([{ collection: "notes", docId: "note-2" }])
      expect(await pendingFor("user-b", 1)).toEqual(["note-2"])
    })

    it("never moves another account's rows", async () => {
      owner = "user-c"
      await journal("note-1")
      owner = "anon-1"
      await journal("note-2")

      await outbox.reattribute({ fromOwnerId: "anon-1", toOwnerId: "user-b", unownedAfterId: 0 })

      expect(await pendingFor("user-c")).toEqual(["note-1"])
      expect(await pendingFor("user-b")).toEqual(["note-2"])
    })

    it("is a no-op on a re-run and on an upgrade in place", async () => {
      owner = "anon-1"
      await journal("note-1")

      await outbox.reattribute({ fromOwnerId: "anon-1", toOwnerId: "user-b", unownedAfterId: 0 })
      await outbox.markSent([1])

      expect(
        await outbox.reattribute({ fromOwnerId: "anon-1", toOwnerId: "user-b", unownedAfterId: 0 })
      ).toEqual([])
      expect(
        await outbox.reattribute({ fromOwnerId: "user-b", toOwnerId: "user-b", unownedAfterId: 0 })
      ).toEqual([])
      expect(await pendingFor("user-b")).toEqual([])
    })

    it("collapses the journal to one ref per document", async () => {
      owner = "anon-1"
      await journal("note-1")
      await journal("note-1")

      const refs = await outbox.reattribute({
        fromOwnerId: "anon-1",
        toOwnerId: "user-b",
        unownedAfterId: 0,
      })

      expect(refs).toEqual([{ collection: "notes", docId: "note-1" }])
      // Both versions still replay, in write order.
      expect(await pendingFor("user-b")).toEqual(["note-1", "note-1"])
    })
  })
})
