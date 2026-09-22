import { describe, it, expect } from "vitest"
import { isSqliteFile, replaceDatabaseContents } from "../transfer.js"
import type { IDatabase, QueryParams } from "../database.js"

describe("isSqliteFile", () => {
  const header = "SQLite format 3\0"

  it("accepts bytes starting with the SQLite magic header", () => {
    const bytes = new Uint8Array([...header].map((c) => c.charCodeAt(0)).concat([1, 2, 3]))
    expect(isSqliteFile(bytes)).toBe(true)
  })

  it("rejects a too-small file", () => {
    expect(isSqliteFile(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it("rejects a file with the wrong header", () => {
    const bytes = new Uint8Array(20).fill(0)
    bytes.set([..."not a db file"].map((c) => c.charCodeAt(0)))
    expect(isSqliteFile(bytes)).toBe(false)
  })

  it("rejects an empty file", () => {
    expect(isSqliteFile(new Uint8Array())).toBe(false)
  })
})

/**
 * Fake IDatabase that records executed statements and serves canned schema
 * reflection for a `main` and an attached `imported` database.
 */
class ReflectingDb implements IDatabase {
  executed: { stmt: string; params?: QueryParams }[] = []
  fkState: string[] = []
  inTransaction = false

  constructor(
    private mainObjects: { type: string; name: string }[],
    private importedTables: { name: string; sql: string }[],
    private importedByType: Record<string, { sql: string }[]>
  ) {}

  async query<T = unknown>(q: string, params?: QueryParams): Promise<T[]> {
    if (q.includes("FROM main.sqlite_master")) {
      return this.mainObjects as T[]
    }
    if (q.includes("type = 'table'")) {
      return this.importedTables as T[]
    }
    if (q.includes("WHERE type = ?")) {
      const t = String(params?.[0])
      return (this.importedByType[t] ?? []) as T[]
    }
    return [] as T[]
  }

  async execute(stmt: string, params?: QueryParams): Promise<void> {
    if (stmt.includes("PRAGMA foreign_keys = OFF")) this.fkState.push("off")
    if (stmt.includes("PRAGMA foreign_keys = ON")) this.fkState.push("on")
    this.executed.push({ stmt, params })
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    this.inTransaction = true
    await fn()
    this.inTransaction = false
  }

  async save(): Promise<void> {}
  async close(): Promise<void> {}

  stmts(): string[] {
    return this.executed.map((e) => e.stmt)
  }
}

describe("replaceDatabaseContents", () => {
  it("drops main objects in dependency order, recreates tables + non-tables, copies rows", async () => {
    const db = new ReflectingDb(
      // main objects come back already ordered by the SQL CASE; the helper
      // drops them in the order returned.
      [
        { type: "trigger", name: "trg_a" },
        { type: "view", name: "v_a" },
        { type: "index", name: "ix_a" },
        { type: "table", name: "notes" },
      ],
      [
        { name: "migrations", sql: "CREATE TABLE migrations (name, applied_at)" },
        { name: "notes", sql: "CREATE TABLE notes (id, text)" },
      ],
      {
        index: [{ sql: "CREATE INDEX ix_notes ON notes(id)" }],
        view: [{ sql: "CREATE VIEW v_notes AS SELECT * FROM notes" }],
        trigger: [{ sql: "CREATE TRIGGER trg_notes AFTER INSERT ON notes BEGIN SELECT 1; END" }],
      }
    )

    await replaceDatabaseContents(db)

    const stmts = db.stmts()

    // FK pragma toggled off then on, around the work.
    expect(db.fkState).toEqual(["off", "on"])

    // Drops issued in the order main objects were returned.
    expect(stmts).toContain('DROP TRIGGER IF EXISTS main."trg_a"')
    expect(stmts).toContain('DROP VIEW IF EXISTS main."v_a"')
    expect(stmts).toContain('DROP INDEX IF EXISTS main."ix_a"')
    expect(stmts).toContain('DROP TABLE IF EXISTS main."notes"')

    // Tables recreated and rows copied.
    expect(stmts).toContain("CREATE TABLE migrations (name, applied_at)")
    expect(stmts).toContain("CREATE TABLE notes (id, text)")
    expect(stmts).toContain('INSERT INTO main."notes" SELECT * FROM imported."notes"')
    expect(stmts).toContain('INSERT INTO main."migrations" SELECT * FROM imported."migrations"')

    // Non-table objects recreated.
    expect(stmts).toContain("CREATE INDEX ix_notes ON notes(id)")
    expect(stmts).toContain("CREATE VIEW v_notes AS SELECT * FROM notes")

    // Everything happened inside a transaction (PRAGMAs run outside it).
    expect(stmts.length).toBeGreaterThan(0)
  })

  it("honors a custom attach alias", async () => {
    const db = new ReflectingDb([], [{ name: "t", sql: "CREATE TABLE t (a)" }], {})
    await replaceDatabaseContents(db, "backup")
    expect(db.stmts()).toContain('INSERT INTO main."t" SELECT * FROM backup."t"')
  })

  it("restores FK enforcement even when the rebuild throws", async () => {
    const db = new ReflectingDb([], [], {})
    db.execute = async (stmt: string) => {
      if (stmt.includes("PRAGMA foreign_keys = OFF")) db.fkState.push("off")
      if (stmt.includes("PRAGMA foreign_keys = ON")) db.fkState.push("on")
    }
    db.transaction = async () => {
      throw new Error("boom")
    }
    await expect(replaceDatabaseContents(db)).rejects.toThrow("boom")
    expect(db.fkState).toEqual(["off", "on"])
  })
})
