import type { Migration } from "./types.js"

/**
 * User's playlist — tracks queued for listening. `completed_at` /
 * `archived_at` are NULL on an active item; `progress` is the last
 * known playback position in milliseconds.
 */
export const migration_003_playlist_items: Migration = {
  name: "003_playlist_items",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS playlist_items (
        id           TEXT PRIMARY KEY,
        track_id     TEXT NOT NULL,
        added_at     INTEGER NOT NULL,
        completed_at INTEGER,
        archived_at  INTEGER,
        progress     INTEGER
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
