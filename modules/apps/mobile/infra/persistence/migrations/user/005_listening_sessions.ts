import type { Migration } from "./types.js"

/**
 * Journal of listening sessions. One row per play→pause/seek/track-change
 * interval. Source of truth for per-item progress, completion, and the
 * activity heatmap. Times are unix seconds; positions are seconds from
 * the start of the track.
 */
export const migration_005_listening_sessions: Migration = {
  name: "005_listening_sessions",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS listening_sessions (
        id            TEXT PRIMARY KEY,
        item_id       TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER NOT NULL,
        from_position INTEGER NOT NULL,
        to_position   INTEGER NOT NULL
      )
    `)
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_listening_sessions_item ON listening_sessions(item_id, ended_at DESC)"
    )
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_listening_sessions_ended ON listening_sessions(ended_at)"
    )
  },
}
