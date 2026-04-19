import type Database from "better-sqlite3"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS migrations (
  name       TEXT PRIMARY KEY,
  scheme     INTEGER,
  applied_at INTEGER NOT NULL
);
`

export interface MigrationFile {
  name: string
  sql: string
  scheme: number | null
}

export function loadMigrations(dir: string): MigrationFile[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort()

  return entries.map((name) => {
    const sql = readFileSync(join(dir, name), "utf8")
    const match = sql.match(/--\s*scheme:\s*(\d+)/i)
    return {
      name: name.replace(/\.sql$/, ""),
      sql,
      scheme: match ? Number(match[1]) : null,
    }
  })
}

export function applyMigrations(db: Database.Database, dir: string): void {
  db.exec(MIGRATIONS_TABLE_DDL)

  const applied = new Set(
    db
      .prepare("SELECT name FROM migrations")
      .all()
      .map((row) => (row as { name: string }).name)
  )

  const migrations = loadMigrations(dir)
  const record = db.prepare(
    "INSERT INTO migrations (name, scheme, applied_at) VALUES (?, ?, ?)"
  )

  for (const m of migrations) {
    if (applied.has(m.name)) continue

    const tx = db.transaction(() => {
      db.exec(m.sql)
      record.run(m.name, m.scheme, Date.now())
    })
    tx()
    console.log(`[migrations] applied ${m.name}${m.scheme ? ` (scheme ${m.scheme})` : ""}`)
  }
}
