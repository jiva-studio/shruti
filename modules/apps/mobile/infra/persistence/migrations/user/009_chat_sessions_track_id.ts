import { addColumnIfMissing } from "./columns.js"
import type { Migration } from "./types.js"

/**
 * Adds `track_id` to `chat_sessions` so a session can be anchored to a
 * specific lecture. Set by the "Ask Sadhu" flow on a transcript
 * selection — every subsequent Sadhu-tap from the same track reuses
 * the most recent session with the matching `track_id` (rather than
 * spawning a new one per fragment).
 *
 * Drives:
 *   - the session header above the message list (author · date · title)
 *   - the lookup performed by `chat_sessions.findLatestByTrack(trackId)`
 *     when the popup dispatches a new focus
 *
 * NULL for free-form sessions (opened from the chat tab without a
 * transcript context) — those continue to behave as before.
 *
 * Partial index on `(track_id, updated_at DESC) WHERE track_id IS NOT NULL`
 * keeps the lookup cheap without bloating the index with NULL rows.
 */
export const migration_009_chat_sessions_track_id: Migration = {
  name: "009_chat_sessions_track_id",
  up: async (db) => {
    await addColumnIfMissing(db, "chat_sessions", "track_id", "track_id TEXT")
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_chat_sessions_track_id_updated " +
        "ON chat_sessions(track_id, updated_at DESC) WHERE track_id IS NOT NULL"
    )
  },
}
