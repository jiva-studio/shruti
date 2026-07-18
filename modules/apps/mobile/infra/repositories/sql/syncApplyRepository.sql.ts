import type { IDatabase } from "@ports/app/index.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { SyncDoc } from "@lib/domain"
import { compareHlcString } from "@lib/domain"
import type {
  NoteRow,
  PlaylistItemRow,
  ListeningSessionRow,
  LibraryItemRow,
  SyncDocHlcRow,
} from "@lib/persistence/user"
import { createIdGenerator } from "./idGenerator.js"
import {
  noteRowToWire,
  playlistRowToWire,
  sessionRowToWire,
  libraryItemRowToWire,
  type NoteWire,
  type PlaylistWire,
  type SessionWire,
  type ChatSessionWire,
  type ChatMessageWire,
  type LibraryItemWire,
} from "./syncWire.js"

/**
 * SQL adapter implementing {@link ISyncApplyRepository}: applies **remote**
 * changes to the three synced collection tables (`notes`, `playlist_items`,
 * `listening_sessions`) and maintains the `sync_doc_hlc` side-table
 * (014 migration).
 *
 * Deliberately bypasses the domain repositories so a pulled change is **not**
 * re-journaled into the outbox (which would echo it back to the server). All
 * writes are raw `db.execute` inside the caller's reentrant unit-of-work.
 *
 * The row snapshots handled here are the client-native (snake_case) wire
 * shapes — identical to what the sync-journal decorator writes into
 * `outbox.data` — so this adapter maps them straight onto columns.
 */

const newPlaylistItemId = createIdGenerator("playlist")

/** Lowest possible HLC — used as the local doc's HLC when none is on record
 *  (e.g. a pre-sync row) so a remote change with any real HLC wins on the LWW
 *  collections, while the add-wins playlist rule still unions the fields. */
const FLOOR_HLC = "000000000000000:00000:0"

export function createSqlSyncApplyRepository(db: IDatabase): ISyncApplyRepository {
  /** Highest of the pending-outbox HLC and the recorded server HLC for a doc,
   *  or `null` when neither exists. */
  async function knownLocalHlc(collection: string, docId: string): Promise<string | null> {
    const outboxRows = await db.query<{ hlc: string }>(
      "SELECT hlc FROM outbox WHERE collection = ? AND doc_id = ? ORDER BY id DESC LIMIT 1",
      [collection, docId]
    )
    const serverRows = await db.query<Pick<SyncDocHlcRow, "server_hlc">>(
      "SELECT server_hlc FROM sync_doc_hlc WHERE collection = ? AND doc_id = ?",
      [collection, docId]
    )
    const outboxHlc = outboxRows[0]?.hlc ?? null
    const serverHlc = serverRows[0]?.server_hlc ?? null
    if (outboxHlc === null) return serverHlc
    if (serverHlc === null) return outboxHlc
    return compareHlcString(outboxHlc, serverHlc) >= 0 ? outboxHlc : serverHlc
  }

  async function readLocalRow(collection: string, docId: string): Promise<unknown | null> {
    switch (collection) {
      case "notes": {
        const rows = await db.query<NoteRow>("SELECT * FROM notes WHERE id = ?", [docId])
        return rows[0] ? noteRowToWire(rows[0]) : null
      }
      case "playlist_items": {
        // doc_id is the natural key track_id, not the local surrogate id.
        const rows = await db.query<PlaylistItemRow>(
          "SELECT * FROM playlist_items WHERE track_id = ? ORDER BY added_at DESC LIMIT 1",
          [docId]
        )
        return rows[0] ? playlistRowToWire(rows[0]) : null
      }
      case "listening_sessions": {
        // Resolve the natural track key via the local playlist item so the
        // snapshot carries `track_id` symmetrically with what the journal
        // decorator writes.
        const rows = await db.query<ListeningSessionRow & { track_id: string | null }>(
          `SELECT ls.*, pi.track_id AS track_id
             FROM listening_sessions ls
             LEFT JOIN playlist_items pi ON pi.id = ls.item_id
            WHERE ls.id = ?`,
          [docId]
        )
        return rows[0] ? sessionRowToWire(rows[0]) : null
      }
      case "chat_sessions": {
        const rows = await db.query<ChatSessionWire>(
          "SELECT id, title, created_at, updated_at, track_id FROM chat_sessions WHERE id = ?",
          [docId]
        )
        return rows[0] ?? null
      }
      case "chat_messages": {
        const rows = await db.query<ChatMessageWire>(
          "SELECT id, session_id, role, content, created_at, meta FROM chat_messages WHERE id = ?",
          [docId]
        )
        return rows[0] ?? null
      }
      case "library_items": {
        // Pull-only: doc_id is the membership id (= library_items.id).
        const rows = await db.query<LibraryItemRow>("SELECT * FROM library_items WHERE id = ?", [
          docId,
        ])
        return rows[0] ? libraryItemRowToWire(rows[0]) : null
      }
      default:
        throw new Error(`syncApply: unknown collection "${collection}"`)
    }
  }

  async function recordServerHlc(collection: string, docId: string, hlc: string): Promise<void> {
    await db.execute(
      `INSERT INTO sync_doc_hlc (collection, doc_id, server_hlc) VALUES (?, ?, ?)
       ON CONFLICT(collection, doc_id) DO UPDATE SET server_hlc = ?`,
      [collection, docId, hlc, hlc]
    )
  }

  async function upsertRow(collection: string, docId: string, data: unknown): Promise<void> {
    switch (collection) {
      case "notes":
        return upsertNote(docId, data as NoteWire)
      case "playlist_items":
        return upsertPlaylist(docId, data as PlaylistWire)
      case "listening_sessions":
        return upsertSession(docId, data as SessionWire)
      case "chat_sessions":
        return upsertChatSession(docId, data as ChatSessionWire)
      case "chat_messages":
        return upsertChatMessage(docId, data as ChatMessageWire)
      case "library_items":
        return upsertLibraryItem(docId, data as LibraryItemWire)
      default:
        throw new Error(`syncApply: unknown collection "${collection}"`)
    }
  }

  async function deleteRow(collection: string, docId: string): Promise<void> {
    switch (collection) {
      case "notes":
        await db.execute("DELETE FROM notes WHERE id = ?", [docId])
        return
      case "playlist_items":
        await db.execute("DELETE FROM playlist_items WHERE track_id = ?", [docId])
        return
      case "listening_sessions":
        await db.execute("DELETE FROM listening_sessions WHERE id = ?", [docId])
        return
      case "chat_sessions":
        // Tombstone-per-session cascade: dropping the session removes its
        // messages locally too, mirroring the server's ON DELETE CASCADE. No
        // per-message tombstones are replicated — this is the whole cascade.
        await db.execute("DELETE FROM chat_messages WHERE session_id = ?", [docId])
        await db.execute("DELETE FROM chat_sessions WHERE id = ?", [docId])
        return
      case "chat_messages":
        await db.execute("DELETE FROM chat_messages WHERE id = ?", [docId])
        return
      case "library_items":
        // Server-authored removal (e.g. "remove from My library") arrives as a
        // tombstone; drop the local membership row.
        await db.execute("DELETE FROM library_items WHERE id = ?", [docId])
        return
      default:
        throw new Error(`syncApply: unknown collection "${collection}"`)
    }
  }

  async function upsertNote(docId: string, wire: NoteWire): Promise<void> {
    // Key on the sync doc_id — the canonical identity every client carries. The
    // row payload's own `id` is optional and not relied upon.
    const meta =
      wire.meta === null || wire.meta === undefined
        ? null
        : typeof wire.meta === "string"
          ? wire.meta
          : JSON.stringify(wire.meta)
    await db.execute(
      `INSERT OR REPLACE INTO notes (id, track_id, text, time_start, time_end, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, wire.track_id, wire.text, wire.time_start, wire.time_end, wire.created_at, meta]
    )
  }

  async function upsertPlaylist(docId: string, wire: PlaylistWire): Promise<void> {
    // Keyed on the natural sync key track_id (= docId), not the wire's local
    // surrogate id (which is the *writing* device's, meaningless here). Reuse
    // the existing local row's id when the track is already present.
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM playlist_items WHERE track_id = ? LIMIT 1",
      [docId]
    )
    if (existing[0]) {
      await db.execute(
        "UPDATE playlist_items SET added_at = ?, archived_at = ?, collection_id = ? WHERE id = ?",
        [wire.added_at, wire.archived_at, wire.collection_id, existing[0].id]
      )
      return
    }
    await db.execute(
      `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id)
       VALUES (?, ?, ?, ?, ?)`,
      [newPlaylistItemId(), docId, wire.added_at, wire.archived_at, wire.collection_id]
    )
  }

  async function upsertSession(docId: string, wire: SessionWire): Promise<void> {
    // Key the row on the sync doc_id (canonical, always present).
    // Re-key on the natural `track_id`: a session pulled from another device
    // carries THAT device's `item_id` (a `pl_…` surrogate that means nothing
    // here). Resolve the LOCAL playlist item for the same track so the session
    // attaches to the right track and stays in the progress / heatmap JOINs.
    // Fall back to the wire `item_id` only when the track isn't in this
    // device's library yet (its `playlist_items` add-wins change is ordered
    // ahead under the single cursor, so this is rare).
    let itemId = wire.item_id
    if (wire.track_id) {
      const local = await db.query<{ id: string }>(
        "SELECT id FROM playlist_items WHERE track_id = ? LIMIT 1",
        [wire.track_id]
      )
      if (local[0]) itemId = local[0].id
    }
    await db.execute(
      `INSERT OR REPLACE INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [docId, itemId, wire.started_at, wire.ended_at, wire.from_position, wire.to_position]
    )
  }

  async function upsertChatSession(docId: string, wire: ChatSessionWire): Promise<void> {
    // Key on the sync doc_id — the canonical identity every client carries; the
    // row payload's own `id` is optional (the web omits it) and not used here.
    //
    // In-place UPSERT, NOT `INSERT OR REPLACE`: the latter is a DELETE+INSERT,
    // and `chat_messages` has `ON DELETE CASCADE` on `session_id` with
    // `foreign_keys = ON`, so replacing a session would wipe its messages.
    // A session's title/updated_at change is ordered AFTER its messages under
    // the single pull cursor, so a REPLACE here cascade-deletes the messages
    // that were just applied — the session then fails the "has a visible
    // message" gate and vanishes from history. DO UPDATE keeps the row alive.
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
  }

  async function upsertChatMessage(docId: string, wire: ChatMessageWire): Promise<void> {
    // Orphan-drop: a message whose parent session is absent locally (never
    // arrived, or already tombstoned — its cascade removed it) is dropped
    // rather than resurrecting the session. Parent-before-child ordering under
    // the single pull cursor guarantees a live session's row is already
    // present by the time its messages apply.
    const parent = await db.query<{ id: string }>(
      "SELECT id FROM chat_sessions WHERE id = ? LIMIT 1",
      [wire.session_id]
    )
    if (!parent[0]) return
    // `meta` is NOT NULL DEFAULT '{"_v":1,"data":{}}'. `INSERT OR REPLACE`
    // used to substitute that default on a NULL; a plain UPSERT aborts on the
    // NOT NULL violation instead, so coalesce an absent meta to the default.
    const meta =
      wire.meta === null || wire.meta === undefined
        ? '{"_v":1,"data":{}}'
        : typeof wire.meta === "string"
          ? wire.meta
          : JSON.stringify(wire.meta)
    // In-place UPSERT, not `INSERT OR REPLACE` (DELETE+INSERT): the message's
    // proactive sidecar cascades on delete, and re-applying a message must not
    // churn rows other tables reference.
    // Key on the sync doc_id — the canonical identity every client carries; the
    // row payload's own `id` is optional and not used here.
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         role       = excluded.role,
         content    = excluded.content,
         created_at = excluded.created_at,
         meta       = excluded.meta`,
      [docId, wire.session_id, wire.role, wire.content, wire.created_at, meta]
    )
  }

  async function upsertLibraryItem(docId: string, wire: LibraryItemWire): Promise<void> {
    // Pull-only, server-owned: the server is the single writer, so the row is
    // applied wholesale keyed on the sync doc_id (= membership id). A plain
    // `INSERT OR REPLACE` is fine — nothing references library_items by FK.
    await db.execute(
      `INSERT OR REPLACE INTO library_items (
         id, track_id, status, origin, title_raw, author_raw, location_raw,
         date_raw, lang_hint, author_id, location_id, date, date_precision,
         lang, lang_confidence, error, audio_key, transcript_key, duration,
         cover_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        wire.track_id ?? null,
        wire.status,
        wire.origin ?? null,
        wire.title_raw ?? null,
        wire.author_raw ?? null,
        wire.location_raw ?? null,
        wire.date_raw ?? null,
        wire.lang_hint ?? null,
        wire.author_id ?? null,
        wire.location_id ?? null,
        wire.date ?? null,
        wire.date_precision ?? null,
        wire.lang ?? null,
        wire.lang_confidence ?? null,
        wire.error ?? null,
        wire.audio_key ?? null,
        wire.transcript_key ?? null,
        wire.duration ?? null,
        wire.cover_key ?? null,
        wire.created_at ?? null,
        wire.updated_at ?? null,
      ]
    )
  }

  return {
    async getLocalDoc(collection: string, docId: string): Promise<SyncDoc<unknown> | null> {
      const localHlc = await knownLocalHlc(collection, docId)
      const row = await readLocalRow(collection, docId)
      if (row === null && localHlc === null) return null
      return {
        docId,
        hlc: localHlc ?? FLOOR_HLC,
        deleted: row === null,
        data: row,
      }
    },

    async applyRemote(collection: string, doc: SyncDoc<unknown>, serverHlc: string): Promise<void> {
      if (doc.deleted || doc.data === null) {
        await deleteRow(collection, doc.docId)
      } else {
        await upsertRow(collection, doc.docId, doc.data)
      }
      await recordServerHlc(collection, doc.docId, serverHlc)
    },

    lastServerHlc: async (collection, docId) => {
      const rows = await db.query<Pick<SyncDocHlcRow, "server_hlc">>(
        "SELECT server_hlc FROM sync_doc_hlc WHERE collection = ? AND doc_id = ?",
        [collection, docId]
      )
      return rows[0]?.server_hlc ?? null
    },

    recordServerHlc,
  }
}
