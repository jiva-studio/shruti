import BetterSqlite3 from "better-sqlite3"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMigrations } from "./applyMigrations.js"
import { importFromCouch } from "./importFromCouch.js"
import { IdMap } from "./idMap.js"
import type { CouchDbConfig } from "./couchdb.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, "..", "migrations")
const ID_MAP_PATH = join(HERE, "..", "state", "id-map.json")

export interface BuildDbOptions {
  outputDir: string
  couch: CouchDbConfig
  /** If set, only this CouchDB author slug's tracks are imported. */
  filterAuthor?: string
}

export interface BuildDbResult {
  /** Path to the freshly built `.db` file. */
  outputFile: string
  /** oldCouchTrackId → new prefixed track id, for the imported tracks.
   *  Used by the media migrator. */
  trackIdMap: ReadonlyMap<string, string>
}

export async function buildDb(opts: BuildDbOptions): Promise<BuildDbResult> {
  const version = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14) // YYYYMMDDHHmmss
  const outputFile = join(opts.outputDir, "public", "db", `shruti.${version}.db`)

  mkdirSync(dirname(outputFile), { recursive: true })
  if (existsSync(outputFile)) rmSync(outputFile)

  const idMap = new IdMap(ID_MAP_PATH)

  const db = new BetterSqlite3(outputFile)
  let trackIdMap: ReadonlyMap<string, string>
  try {
    db.pragma("journal_mode = MEMORY")
    db.pragma("foreign_keys = OFF")

    applyMigrations(db, MIGRATIONS_DIR)

    const result = await importFromCouch(db, opts.couch, {
      idMap,
      filterAuthor: opts.filterAuthor,
    })
    console.log("[build] import stats:", result.stats)
    trackIdMap = result.trackIdMap

    db.pragma("wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }

  console.log(`[build] wrote ${outputFile}`)
  return { outputFile, trackIdMap }
}
