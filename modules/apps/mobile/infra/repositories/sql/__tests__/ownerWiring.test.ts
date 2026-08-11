import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase, applyUserSchemaForTests } from "./testDb.js"
import { createSqlAppRepositories } from "../index.js"

/**
 * Guards the wiring that carries the auth session into every journaled row
 * (#1497). Both write paths — the journal decorator wrapping the domain repos,
 * and the outbox adapter the sync engine appends through — have to be handed
 * `getOwnerId` by the factory.
 *
 * Worth its own test because the failure is invisible: drop the dep and rows
 * simply journal unowned, every other test stays green, and push silently
 * degrades to the id-range watermark that cannot tell two identities apart.
 * (The composition root's end of the same wire is guarded by the type: the
 * `getOwnerId` it passes is a required dep, so deleting it fails the build.)
 */
describe("createSqlAppRepositories — owner wiring", () => {
  let db: IDatabase
  let owner: string | null

  const ownerIds = async () =>
    (
      await db.query<{ owner_id: string | null }>("SELECT owner_id FROM outbox ORDER BY id ASC")
    ).map((r) => r.owner_id)

  const repos = () =>
    createSqlAppRepositories({
      contentDb: db,
      userDb: db,
      getActiveLanguage: () => "en",
      getDeviceId: async () => "dev-test",
      getOwnerId: () => owner,
    })

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
    await db.execute(
      `CREATE TABLE outbox (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         collection TEXT NOT NULL, doc_id TEXT NOT NULL, op TEXT NOT NULL,
         data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
         created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
         owner_id TEXT
       )`
    )
    // The journal seeds its stamp from the outbox tail AND the recorded server
    // pointers, so the side-table (014) belongs in this fixture too.
    await db.execute(
      `CREATE TABLE sync_doc_hlc (
         collection TEXT NOT NULL,
         doc_id     TEXT NOT NULL,
         server_hlc TEXT NOT NULL,
         PRIMARY KEY (collection, doc_id)
       )`
    )
    owner = "user-1"
  })

  it("stamps a domain write with the account that made it", async () => {
    const r = repos()
    await r.notes.create({ trackId: "t1", text: "hi", timeStart: 0, timeEnd: 5 })

    expect(await ownerIds()).toEqual(["user-1"])
  })

  it("follows the account across a switch without rebuilding the repositories", async () => {
    const r = repos()
    await r.notes.create({ trackId: "t1", text: "before", timeStart: 0, timeEnd: 5 })
    // Account deleted mid-life of the bundle; the provider is read per write.
    owner = "anon-2"
    await r.notes.create({ trackId: "t1", text: "after", timeStart: 0, timeEnd: 5 })

    expect(await ownerIds()).toEqual(["user-1", "anon-2"])
  })

  it("stamps the engine's own appends too", async () => {
    const r = repos()
    await r.syncOutbox!.append({
      collection: "notes",
      docId: "note-x",
      op: "upsert",
      data: { id: "note-x" },
      hlc: "0000000000001-0000-dev",
      baseHlc: null,
    })

    expect(await ownerIds()).toEqual(["user-1"])
  })
})
