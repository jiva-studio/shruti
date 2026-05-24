import type { Migration } from "./types.js"

/**
 * Key-value config store for the app's runtime-tunable settings
 * (selected language, theme, filter preferences, tutorial state, etc.).
 * No schema changes when a new key is introduced.
 */
export const migration_001_config_table: Migration = {
  name: "001_config_table",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  },
}
