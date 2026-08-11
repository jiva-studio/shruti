import initSqlJs, { type Database as SqlJsDb } from "sql.js"
import type { IDatabase, QueryParams } from "@ports/app/index.js"
import { createSqlJsDatabase } from "@infra/persistence/sqljs/index.js"

/**
 * Creates an in-memory sql.js IDatabase for use in repository tests.
 * `save()` is a no-op so tests don't need IndexedDB support in Node — which
 * also means nothing here can observe durability. Use
 * {@link createPersistingTestDatabase} when that is the point of the test.
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
 * An in-memory database wired to a durable store, the way the web build is.
 * `persistedBytes()` is what a reload would find — assert against that (or a
 * {@link PersistingTestDatabase.reload}ed handle) rather than the live image,
 * which every uncommitted or unexported write still flatters.
 */
export interface PersistingTestDatabase {
  /** The database under test — the real web adapter, minus IndexedDB. */
  readonly db: IDatabase
  /** The last exported image, or `null` when nothing was ever exported. */
  persistedBytes(): Uint8Array | null
  /** Opens the persisted image as a fresh database. Throws if nothing was
   *  ever exported — a reload would have found no user data at all. */
  reload(): Promise<IDatabase>
}

/**
 * The web persistence adapter over an in-memory export sink, so a test can see
 * whether a write actually became durable. `createInMemoryTestDatabase` cannot:
 * its `save()` is a no-op and its `transaction()` has nowhere to export to, so
 * every write looks durable there (#1631).
 */
export async function createPersistingTestDatabase(): Promise<PersistingTestDatabase> {
  const SQL = await initSqlJs()
  let persisted: Uint8Array | null = null

  const db = createSqlJsDatabase(new SQL.Database(), async (data) => {
    persisted = data
  })

  return {
    db,
    persistedBytes: () => persisted,
    async reload(): Promise<IDatabase> {
      if (persisted === null) throw new Error("nothing was ever persisted")
      return createSqlJsDatabase(new SQL.Database(persisted), async (data) => {
        persisted = data
      })
    },
  }
}

/**
 * Applies the minimal user-DB schema the repositories tests need.
 * Kept inline here so infra tests don't reach up into `@shruti/*`.
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
