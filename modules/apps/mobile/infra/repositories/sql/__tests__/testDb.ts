import initSqlJs, { type Database as SqlJsDb } from "sql.js"
import type { IDatabase, QueryParams } from "@ports/app/index.js"

/**
 * Creates an in-memory sql.js IDatabase for use in repository tests.
 * `save()` is a no-op so tests don't need IndexedDB support in Node.
 */
export async function createInMemoryTestDatabase(): Promise<IDatabase> {
  const SQL = await initSqlJs()
  const db: SqlJsDb = new SQL.Database()

  return {
    async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
      const stmt = db.prepare(sql)
      if (params?.length) stmt.bind(params as never)
      const results: T[] = []
      while (stmt.step()) results.push(stmt.getAsObject() as T)
      stmt.free()
      return results
    },

    async execute(sql: string, params?: QueryParams): Promise<void> {
      db.run(sql, params as never)
    },

    async transaction(fn: () => Promise<void>): Promise<void> {
      try {
        db.run("BEGIN")
        await fn()
        db.run("COMMIT")
      } catch (error) {
        db.run("ROLLBACK")
        throw error
      }
    },

    async save(): Promise<void> {
      /* no-op for tests */
    },

    async close(): Promise<void> {
      db.close()
    },
  }
}

/**
 * Applies the minimal user-DB schema the repositories tests need.
 * Kept inline here so infra tests don't reach up into `@lectorium/*`.
 * Mirrors `infra/persistence/migrations/user/{000,001,002,003,004,005,006,025}_*.ts` —
 * if a migration changes schema-visible shape, update this too.
 */
export async function applyUserSchemaForTests(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS notes (
       id         TEXT PRIMARY KEY,
       track_id   TEXT NOT NULL,
       text       TEXT NOT NULL,
       time_start INTEGER NOT NULL,
       time_end   INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       meta       TEXT
     )`
  )
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_track ON notes(track_id, time_start)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC)`)
  await db.execute(
    `CREATE TABLE IF NOT EXISTS playlist_items (
       id           TEXT PRIMARY KEY,
       track_id     TEXT NOT NULL,
       added_at     INTEGER NOT NULL,
       archived_at  INTEGER
     )`
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS listening_sessions (
       id            TEXT PRIMARY KEY,
       item_id       TEXT NOT NULL,
       started_at    INTEGER NOT NULL,
       ended_at      INTEGER NOT NULL,
       from_position INTEGER NOT NULL,
       to_position   INTEGER NOT NULL,
       source_key    TEXT
     )`
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_listening_sessions_item
       ON listening_sessions(item_id, ended_at DESC)`
  )
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listening_sessions_source_key
       ON listening_sessions(source_key)`
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_listening_sessions_ended
       ON listening_sessions(ended_at)`
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS media_items (
       id         TEXT PRIMARY KEY,
       track_id   TEXT NOT NULL,
       kind       TEXT NOT NULL DEFAULT 'original',
       state      TEXT NOT NULL,
       local_path TEXT,
       created_at INTEGER NOT NULL
     )`
  )
}
