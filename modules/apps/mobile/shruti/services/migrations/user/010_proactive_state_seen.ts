import type { Migration } from "./types.js"

/**
 * `seen_at` — unix seconds when the user first opened the chat session
 * containing this proactive message. Drives both the per-session dot
 * and the tab-level Sadhu badge — a row with `seen_at IS NULL` shows
 * the per-session dot; the badge is the count (>0?) of such rows.
 *
 * NULLable so we can distinguish "never opened" (default) from
 * "opened at some moment". The previous design lived in two places —
 * a `proactive.inboxLastSeenAtMs` watermark in Capacitor Preferences
 * for the badge, and the absence of a user reply for the per-session
 * dot — and they drifted apart in practice. One column, one
 * semantic.
 */
export const migration_010_proactive_state_seen: Migration = {
  name: "010_proactive_state_seen",
  up: async (db) => {
    await db.execute("ALTER TABLE chat_messages_proactive_state ADD COLUMN seen_at INTEGER")
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_proactive_state_seen_at ON chat_messages_proactive_state(seen_at)"
    )
  },
}
