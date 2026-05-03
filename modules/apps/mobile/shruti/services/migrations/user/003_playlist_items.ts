import type { Migration } from "./types.js"

/**
 * User's playlist — tracks queued for listening. `archived_at` is NULL
 * on an active item. Per-item progress and completion are derived from
 * the `listening_sessions` journal (see migration 005).
 */
export const migration_003_playlist_items: Migration = {
  name: "003_playlist_items",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS playlist_items (
        id           TEXT PRIMARY KEY,
        track_id     TEXT NOT NULL,
        added_at     INTEGER NOT NULL,
        archived_at  INTEGER
      )
    `)
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_playlist_added_at ON playlist_items(added_at DESC)"
    )
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_playlist_active
         ON playlist_items(added_at DESC)
         WHERE archived_at IS NULL`
    )
  },
}
