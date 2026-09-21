import type { IDatabase } from "@ports/app/index.js"
import type { ListeningSessionRow, NoteRow, PlaylistItemRow } from "@lib/persistence/user"
import { createIdGenerator } from "./idGenerator.js"
import type { CollectionTable, CollectionTables } from "./syncCollections.js"
import {
  noteRowToWire,
  playlistRowToWire,
  sessionRowToWire,
  type NoteWire,
  type PlaylistWire,
  type SessionWire,
} from "./syncWire.js"

const newPlaylistItemId = createIdGenerator("playlist")

/**
 * The local `playlist_items.id` for a track, or null when the track isn't on
 * this device.
 *
 * The row is unique per `track_id`, so there is normally exactly one. The
 * ORDER BY is what makes the answer well-defined on a device that still
 * carries a duplicate: an unordered `LIMIT 1` is a rowid scan and returns the
 * OLDEST row — the one archive-then-re-add left behind — while the read below
 * merges from the newest. Every `track_id` lookup on this path goes through
 * here so read and write cannot drift apart.
 */
async function canonicalItemId(db: IDatabase, trackId: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM playlist_items WHERE track_id = ? ORDER BY added_at DESC, id DESC LIMIT 1",
    [trackId]
  )
  return rows[0]?.id ?? null
}

/** A wire `meta` field as the column stores it: a string passes through, an
 *  object is serialized, and absence maps to `fallback`. */
function metaColumn(meta: unknown, fallback: string | null): string | null {
  if (meta === null || meta === undefined) return fallback
  return typeof meta === "string" ? meta : JSON.stringify(meta)
}

// Keyed on the sync doc_id — the canonical identity every client carries. The
// row payload's own `id` is optional and not relied upon.
const notes: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<NoteRow>("SELECT * FROM notes WHERE id = ?", [docId])
    return rows[0] ? noteRowToWire(rows[0]) : null
  },
  async upsert(db, docId, data) {
    const wire = data as NoteWire
    await db.execute(
      `INSERT OR REPLACE INTO notes (id, track_id, text, time_start, time_end, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        wire.track_id,
        wire.text,
        wire.time_start,
        wire.time_end,
        wire.created_at,
        metaColumn(wire.meta, null),
      ]
    )
  },
  async remove(db, docId) {
    await db.execute("DELETE FROM notes WHERE id = ?", [docId])
  },
}

// doc_id is the natural key track_id, not the local surrogate id, which is the
// *writing* device's and means nothing here.
const playlistItems: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<PlaylistItemRow>(
      "SELECT * FROM playlist_items WHERE track_id = ? ORDER BY added_at DESC, id DESC LIMIT 1",
      [docId]
    )
    return rows[0] ? playlistRowToWire(rows[0]) : null
  },
  async upsert(db, docId, data) {
    const wire = data as PlaylistWire
    const existingId = await canonicalItemId(db, docId)
    if (existingId !== null) {
      await db.execute(
        "UPDATE playlist_items SET added_at = ?, archived_at = ?, collection_id = ? WHERE id = ?",
        [wire.added_at, wire.archived_at, wire.collection_id, existingId]
      )
      return
    }
    await db.execute(
      `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id)
       VALUES (?, ?, ?, ?, ?)`,
      [newPlaylistItemId(), docId, wire.added_at, wire.archived_at, wire.collection_id]
    )
  },
  async remove(db, docId) {
    await db.execute("DELETE FROM playlist_items WHERE track_id = ?", [docId])
  },
}

const listeningSessions: CollectionTable = {
  async read(db, docId) {
    // Resolve the natural track key via the local playlist item so the
    // snapshot carries `track_id` symmetrically with what the journal writes.
    const rows = await db.query<ListeningSessionRow & { track_id: string | null }>(
      `SELECT ls.*, pi.track_id AS track_id
         FROM listening_sessions ls
         LEFT JOIN playlist_items pi ON pi.id = ls.item_id
        WHERE ls.id = ?`,
      [docId]
    )
    return rows[0] ? sessionRowToWire(rows[0]) : null
  },
  async upsert(db, docId, data) {
    const wire = data as SessionWire
    // A session pulled from another device carries THAT device's `item_id`.
    // Resolve the LOCAL item for the same track so the session attaches to the
    // right track and stays in the progress / heatmap JOINs; fall back to the
    // wire's only when the track isn't in this device's library yet.
    let itemId = wire.item_id
    if (wire.track_id) {
      const local = await canonicalItemId(db, wire.track_id)
      if (local !== null) itemId = local
    }
    // An in-place UPSERT listing only the synced columns, NOT `INSERT OR
    // REPLACE`: that is a DELETE+INSERT, and the row also carries the
    // local-only `source_key`, which the wire never brings back — a REPLACE
    // nulls it and disarms the queue-journal dedup for that row.
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         item_id       = excluded.item_id,
         started_at    = excluded.started_at,
         ended_at      = excluded.ended_at,
         from_position = excluded.from_position,
         to_position   = excluded.to_position`,
      [docId, itemId, wire.started_at, wire.ended_at, wire.from_position, wire.to_position]
    )
  },
  async remove(db, docId) {
    await db.execute("DELETE FROM listening_sessions WHERE id = ?", [docId])
  },
}

export const USER_CONTENT_TABLES: CollectionTables = {
  notes,
  playlist_items: playlistItems,
  listening_sessions: listeningSessions,
}

export { metaColumn }
