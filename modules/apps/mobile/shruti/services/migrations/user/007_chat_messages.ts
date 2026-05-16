import type { Migration } from "./types.js"

/**
 * Per-device chat history for the Sadhu chat tab. Two tables: sessions
 * group messages into conversations and store the title / timestamps;
 * messages keep the raw assistant markdown (with inline [cite:...] and
 * [card:...] markers) so we can re-render the same widgets after a
 * reload. Cascading delete on session removal — the marker-rendering
 * layer treats orphan messages as a bug, never a state to recover from.
 */
export const migration_007_chat_messages: Migration = {
  name: "007_chat_messages",
  up: async (db) => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      )
    `)
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at)"
    )
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC)"
    )
  },
}
