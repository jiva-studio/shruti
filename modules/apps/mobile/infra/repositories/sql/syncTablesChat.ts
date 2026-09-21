import type { CollectionTable, CollectionTables } from "./syncCollections.js"
import { metaColumn } from "./syncTablesUserContent.js"
import type { ChatMessageWire, ChatSessionWire } from "./syncWire.js"

const EMPTY_META = '{"_v":1,"data":{}}'

const chatSessions: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<ChatSessionWire>(
      "SELECT id, title, created_at, updated_at, track_id FROM chat_sessions WHERE id = ?",
      [docId]
    )
    return rows[0] ?? null
  },
  async upsert(db, docId, data) {
    const wire = data as ChatSessionWire
    // An in-place UPSERT, NOT `INSERT OR REPLACE`: the latter is a
    // DELETE+INSERT, and `chat_messages` has `ON DELETE CASCADE` on
    // `session_id`. A session's title change is ordered AFTER its messages
    // under the single pull cursor, so a REPLACE would cascade-delete the
    // messages just applied and the session would vanish from history.
    await db.execute(
      `INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title      = excluded.title,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         track_id   = excluded.track_id`,
      [docId, wire.title, wire.created_at, wire.updated_at, wire.track_id]
    )
  },
  async remove(db, docId) {
    // Tombstone-per-session cascade: dropping the session removes its messages
    // locally too, mirroring the server's ON DELETE CASCADE. No per-message
    // tombstones are replicated — this is the whole cascade.
    await db.execute("DELETE FROM chat_messages WHERE session_id = ?", [docId])
    await db.execute("DELETE FROM chat_sessions WHERE id = ?", [docId])
  },
}

const chatMessages: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<ChatMessageWire>(
      "SELECT id, session_id, role, content, created_at, meta FROM chat_messages WHERE id = ?",
      [docId]
    )
    return rows[0] ?? null
  },
  async upsert(db, docId, data) {
    const wire = data as ChatMessageWire
    // Orphan-drop: a message whose parent session is absent locally (never
    // arrived, or already tombstoned) is dropped rather than resurrecting the
    // session. Parent-before-child ordering under the single pull cursor
    // guarantees a live session's row is present by the time its messages
    // apply.
    const parent = await db.query<{ id: string }>(
      "SELECT id FROM chat_sessions WHERE id = ? LIMIT 1",
      [wire.session_id]
    )
    if (!parent[0]) return
    // `meta` is NOT NULL, and a plain UPSERT aborts on the violation instead
    // of substituting the column default, so an absent meta is coalesced here.
    //
    // In-place, not `INSERT OR REPLACE`: the message's proactive sidecar
    // cascades on delete, and re-applying a message must not churn rows other
    // tables reference.
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         role       = excluded.role,
         content    = excluded.content,
         created_at = excluded.created_at,
         meta       = excluded.meta`,
      [
        docId,
        wire.session_id,
        wire.role,
        wire.content,
        wire.created_at,
        metaColumn(wire.meta, EMPTY_META),
      ]
    )
  },
  async remove(db, docId) {
    await db.execute("DELETE FROM chat_messages WHERE id = ?", [docId])
  },
}

export const CHAT_TABLES: CollectionTables = {
  chat_sessions: chatSessions,
  chat_messages: chatMessages,
}
