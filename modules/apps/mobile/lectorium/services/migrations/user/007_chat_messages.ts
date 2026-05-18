import type { Migration } from "./types.js"

/**
 * Per-device chat history for the Sadhu chat tab. Final shape — no
 * follow-up ALTER migrations. Two tables: sessions group messages into
 * conversations + carry display metadata; messages keep the raw
 * assistant markdown (with inline `[cite:...]`, `[card:...]`,
 * `[action:...]`, `[outline:...]`, `[followup:...]` markers) so the
 * bubble renderer can rebuild the same UI tokens after a reload.
 *
 * `meta` is a single versioned JSON envelope `{ _v, data }`. Inside
 * `data` we keep:
 *   - `actions`: id → ChatActionPayload (playlist / save_note / share_pdf / …)
 *   - `outlines`: trackId → ChatOutlinePayload (chapter list)
 *   - `actionStates`: id → 'pending'|'executing'|'done'|'error'
 *   - `followups`: string[] (tappable chip texts at end of message)
 *   - `error?`: ChatMessageError ({kind:"truncated", reason:"stream"|"turns"})
 *
 * One JSON column means one parse per row, one place to evolve.
 *
 * Cascading delete on session removal — the marker-rendering layer
 * treats orphan messages as a bug, never a state to recover from.
 *
 * `CHECK(role IN ('user','assistant'))` enforces the role enum at the
 * DB boundary — bad data falls into INSERT errors, not silent
 * fallbacks in `rowToMessage`.
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
        role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        meta       TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
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
