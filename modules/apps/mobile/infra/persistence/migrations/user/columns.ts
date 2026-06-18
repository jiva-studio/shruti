import type { IDatabase } from "@ports/app/index.js"

/**
 * Idempotent `ALTER TABLE … ADD COLUMN`.
 *
 * The kit migration engine records a migration as applied only after its
 * `up` commits, but on the native Capacitor adapter a process kill between a
 * durable DDL commit and the `migrations` INSERT can leave the column added
 * yet the migration unrecorded. The next launch then replays the bare
 * `ADD COLUMN` and SQLite throws "duplicate column name". Probe the live
 * schema first and skip the ALTER when the column already exists, so a
 * replay is a harmless no-op instead of a hard failure.
 *
 * `table`/`column`/`columnDdl` are compile-time constants from the migration
 * files (never user input), so interpolating them into `PRAGMA table_info` —
 * which does not accept bound parameters — is safe.
 */
export async function addColumnIfMissing(
  db: IDatabase,
  table: string,
  column: string,
  columnDdl: string
): Promise<void> {
  const cols = await db.query<{ name: string }>(`PRAGMA table_info(${table})`)
  if (cols.some((c) => c.name === column)) return
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`)
}
