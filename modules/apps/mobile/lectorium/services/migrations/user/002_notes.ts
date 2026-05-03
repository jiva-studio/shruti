import type { Migration } from "./types.js"

/**
 * Per-device notes a user attaches to a (trackId, time range). Phase 6.4
 * builds the create/list/edit/delete use cases on top of this table.
 */
export const migration_002_notes: Migration = {
  name: "002_notes",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        track_id   TEXT NOT NULL,
        text       TEXT NOT NULL,
        time_start INTEGER NOT NULL,
        time_end   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    await db.execute("CREATE INDEX IF NOT EXISTS idx_notes_track ON notes(track_id, time_start)")
    await db.execute("CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC)")
  },
}
