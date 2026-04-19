import type { Migration } from "./types.js"

/**
 * Offline media cache state: one row per downloaded track audio file.
 * Used by the downloader feature (Phase 6.6) to resolve local playback
 * URLs and to list "Available offline" tracks.
 */
export const migration_004_media_items: Migration = {
  name: "004_media_items",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS media_items (
        id         TEXT PRIMARY KEY,
        track_id   TEXT NOT NULL,
        state      TEXT NOT NULL,   -- pending | downloading | ready | failed
        local_path TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_track ON media_items(track_id)"
    )
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_media_items_state ON media_items(state)"
    )
  },
}
