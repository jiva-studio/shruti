import { describe, it, expect, vi, beforeEach } from "vitest"

// A fake native DB connection whose `run` always rejects the way the Capacitor
// plugin does on a read-only connection — the prebuilt content DB.
const fakeDb = {
  open: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockRejectedValue(new Error("not allowed in read-only mode")),
  query: vi.fn().mockResolvedValue({ values: [] }),
  close: vi.fn().mockResolvedValue(undefined),
  beginTransaction: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
  rollbackTransaction: vi.fn().mockResolvedValue(undefined),
}

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    checkConnectionsConsistency = vi.fn().mockResolvedValue(undefined)
    isNCConnection = vi.fn().mockResolvedValue({ result: false })
    closeNCConnection = vi.fn().mockResolvedValue(undefined)
    isConnection = vi.fn().mockResolvedValue({ result: false })
    closeConnection = vi.fn().mockResolvedValue(undefined)
    getNCDatabasePath = vi.fn().mockResolvedValue({ path: "/data/files/databases/content.db" })
    createNCConnection = vi.fn().mockResolvedValue(fakeDb)
    createConnection = vi.fn().mockResolvedValue(fakeDb)
  },
}))
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }))
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { mkdir: vi.fn().mockResolvedValue(undefined) },
  Directory: { Data: "DATA" },
}))

import { useCapacitorSqlPersistence } from "../useCapacitorSqlPersistence.js"

describe("useCapacitorSqlPersistence — read-only content DB", () => {
  beforeEach(() => {
    fakeDb.run.mockClear()
  })

  it("opens even when the startup pragmas are rejected on a read-only connection", async () => {
    const db = await useCapacitorSqlPersistence().open("databases/content.db")

    // Bootstrap regressed here: the FK/busy_timeout pragmas ran on the
    // read-only content DB, and the plugin's rejection escaped open() →
    // "[kit/bootstrap] startup failed: not allowed in read-only mode".
    expect(db).toBeDefined()
    // The pragmas were still attempted (and swallowed)…
    expect(fakeDb.run).toHaveBeenCalledWith("PRAGMA foreign_keys = ON", [], false)
    // …and the opened DB is usable for the reads bootstrap then does.
    expect(await db.query("SELECT count(*) FROM tracks")).toEqual([])
  })
})
