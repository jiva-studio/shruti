import type { Migration } from "./types.js"

/**
 * Bootstraps the `migrations` table itself. Applied unconditionally by
 * `runUserMigrations` before any other migration runs.
 */
export const migration_000_migrations_table: Migration = {
  name: "000_migrations_table",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)
  },
}
