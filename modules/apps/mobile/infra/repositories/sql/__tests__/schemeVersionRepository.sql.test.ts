import { describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlSchemeVersionRepository } from "../schemeVersionRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function applyMigrationsTable(db: IDatabase, scheme: number | null): Promise<void> {
  await db.execute(`CREATE TABLE migrations (
    name   TEXT PRIMARY KEY,
    scheme INTEGER
  )`)
  await db.execute(`INSERT INTO migrations (name, scheme) VALUES ('001_init', ?)`, [scheme])
}

async function applyTracksTable(db: IDatabase, rows: number): Promise<void> {
  await db.execute(`CREATE TABLE tracks (id TEXT PRIMARY KEY)`)
  for (let i = 0; i < rows; i++) {
    await db.execute(`INSERT INTO tracks (id) VALUES (?)`, [`t${i}`])
  }
}

describe("schemeVersionRepository.sql — read", () => {
  it("returns the recorded scheme from the migrations table", async () => {
    const db = await createInMemoryTestDatabase()
    await applyMigrationsTable(db, 7)
    await applyTracksTable(db, 1)

    const scheme = await createSqlSchemeVersionRepository(db).read()
    expect(scheme).toBe(7)
  })

  it("returns 0 for a legacy DB with no scheme row but a readable tracks table", async () => {
    // No `migrations` table at all — the canonical pre-scheme legacy shape.
    const db = await createInMemoryTestDatabase()
    await applyTracksTable(db, 3)

    const scheme = await createSqlSchemeVersionRepository(db).read()
    expect(scheme).toBe(0)
  })

  it("returns 0 for a migrations table whose scheme is NULL when tracks is readable", async () => {
    const db = await createInMemoryTestDatabase()
    await applyMigrationsTable(db, null)
    await applyTracksTable(db, 1)

    const scheme = await createSqlSchemeVersionRepository(db).read()
    expect(scheme).toBe(0)
  })

  it("returns 0 even when the tracks table is empty (presence, not row count, is the gate)", async () => {
    const db = await createInMemoryTestDatabase()
    await applyTracksTable(db, 0)

    const scheme = await createSqlSchemeVersionRepository(db).read()
    expect(scheme).toBe(0)
  })

  it("throws instead of masquerading as legacy 0 when the DB is unreadable", async () => {
    // Neither a migrations scheme row nor a tracks table: a corrupt / truncated
    // file looks like this, and must NOT be accepted as a valid legacy DB.
    const db = await createInMemoryTestDatabase()

    await expect(createSqlSchemeVersionRepository(db).read()).rejects.toThrow(
      /Content database is unreadable/
    )
  })
})
