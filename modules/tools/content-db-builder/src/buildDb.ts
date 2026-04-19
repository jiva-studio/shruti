import BetterSqlite3 from "better-sqlite3"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMigrations } from "./applyMigrations.js"
import { importFromCouch } from "./importFromCouch.js"
import type { CouchDbConfig } from "./couchdb.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, "..", "migrations")

export interface BuildDbOptions {
  outputDir: string
  couch: CouchDbConfig
}

export async function buildDb(opts: BuildDbOptions): Promise<string> {
  const version = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14) // YYYYMMDDHHmmss
  const outputFile = join(opts.outputDir, "public", "db", `shruti.${version}.db`)

  mkdirSync(dirname(outputFile), { recursive: true })
  if (existsSync(outputFile)) rmSync(outputFile)

  const db = new BetterSqlite3(outputFile)
  try {
    db.pragma("journal_mode = MEMORY")
    db.pragma("foreign_keys = OFF")

    applyMigrations(db, MIGRATIONS_DIR)

    const stats = await importFromCouch(db, opts.couch)
    console.log("[build] import stats:", stats)

    db.pragma("wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }

  console.log(`[build] wrote ${outputFile}`)
  return outputFile
}
