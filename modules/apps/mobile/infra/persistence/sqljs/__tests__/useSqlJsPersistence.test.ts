import { beforeEach, describe, expect, it, vi } from "vitest"
import initSqlJs from "sql.js"

/**
 * Durability contract of the web (sql.js) persistence adapter — #1631.
 *
 * On the native adapter COMMIT *is* durability, so the sync-lane repositories
 * (outbox, sync_state, sync_doc_hlc) and the account wipe write with raw
 * `db.execute` and never call `save()`. On web the in-memory image only becomes
 * durable when it is exported to IndexedDB, so a committed transaction that
 * exported nothing is a write the next reload does not have.
 */

const idb = vi.hoisted(() => ({
  /** Bytes handed to IndexedDB, newest last. */
  saved: [] as Uint8Array[],
  /** What `getBlob` returns when the adapter opens the database. */
  initial: null as Uint8Array | null,
}))

vi.mock("@kit/infra", () => ({
  saveData: async (_dbName: string, _store: string, _key: string, data: Uint8Array) => {
    idb.saved.push(data)
  },
  getBlob: async () => idb.initial,
}))

// The adapter resolves the wasm through Vite's `?url` asset pipeline, which
// yields a browser URL Node cannot read. Point it at the file on disk instead.
vi.mock("sql.js/dist/sql-wasm-browser.wasm?url", () => ({
  default: new URL("../../../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname,
}))

const { useSqlJsPersistence } = await import("../useSqlJsPersistence.js")

const DB_PATH = "lectorium/blobs/user.db"

/** The rows a reload would see: read the last exported image, not the live one. */
async function persistedNotes(): Promise<string[]> {
  const bytes = idb.saved.at(-1)
  if (!bytes) return []
  const SQL = await initSqlJs()
  const reloaded = new SQL.Database(bytes)
  try {
    const stmt = reloaded.prepare("SELECT text FROM notes ORDER BY text")
    const out: string[] = []
    while (stmt.step()) out.push(stmt.getAsObject().text as string)
    stmt.free()
    return out
  } finally {
    reloaded.close()
  }
}

describe("useSqlJsPersistence durability", () => {
  beforeEach(() => {
    idb.saved = []
    idb.initial = null
  })

  it("exports a committed transaction whose body only called execute", async () => {
    const db = await useSqlJsPersistence().open(DB_PATH)
    await db.execute("CREATE TABLE notes (text TEXT)")
    await db.save()
    idb.saved = []

    // Exactly the shape every sync-lane write has: raw execute inside the
    // caller's transaction, no `save()` anywhere.
    await db.transaction(async () => {
      await db.execute("INSERT INTO notes (text) VALUES ('journaled')")
    })

    expect(idb.saved).toHaveLength(1)
    expect(await persistedNotes()).toEqual(["journaled"])
  })

  it("exports a delete issued the same way, so a wipe cannot undo itself", async () => {
    const db = await useSqlJsPersistence().open(DB_PATH)
    await db.execute("CREATE TABLE notes (text TEXT)")
    await db.execute("INSERT INTO notes (text) VALUES ('stale')")
    await db.save()

    await db.transaction(async () => {
      await db.execute("DELETE FROM notes")
    })

    expect(await persistedNotes()).toEqual([])
  })

  it("still exports once when a repo inside the transaction called save()", async () => {
    const db = await useSqlJsPersistence().open(DB_PATH)
    await db.execute("CREATE TABLE notes (text TEXT)")
    await db.save()
    idb.saved = []

    await db.transaction(async () => {
      await db.execute("INSERT INTO notes (text) VALUES ('a')")
      await db.save()
      await db.execute("INSERT INTO notes (text) VALUES ('b')")
      await db.save()
    })

    expect(idb.saved).toHaveLength(1)
    expect(await persistedNotes()).toEqual(["a", "b"])
  })

  it("does not export a read-only transaction", async () => {
    const db = await useSqlJsPersistence().open(DB_PATH)
    await db.execute("CREATE TABLE notes (text TEXT)")
    await db.save()
    idb.saved = []

    await db.transaction(async () => {
      await db.query("SELECT * FROM notes")
    })

    expect(idb.saved).toEqual([])
  })

  it("does not export a rolled-back transaction", async () => {
    const db = await useSqlJsPersistence().open(DB_PATH)
    await db.execute("CREATE TABLE notes (text TEXT)")
    await db.execute("INSERT INTO notes (text) VALUES ('kept')")
    await db.save()
    idb.saved = []

    await expect(
      db.transaction(async () => {
        await db.execute("INSERT INTO notes (text) VALUES ('doomed')")
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    expect(idb.saved).toEqual([])
  })
})
