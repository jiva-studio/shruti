import type { IDatabase } from "@ports/app/index.js"
import type {
  BackfillCandidate,
  ISyncBackfillRepository,
} from "@lib/domain/ports/syncBackfillRepository.js"
import type { NoteRow, PlaylistItemRow, ListeningSessionRow } from "@lib/persistence/user"
import { rowToNote, rowToPlaylistItem } from "./rowMappers.js"

/**
 * SQL adapter over the three synced collection tables implementing
 * {@link ISyncBackfillRepository} — the read side of the first-sync backfill
 * (Lane E2b).
 *
 * `listUnsynced` returns every `notes` / `playlist_items` /
 * `listening_sessions` row that has **no** matching `outbox` entry and **no**
 * `sync_doc_hlc` record — the rows created before journaling was on (while the
 * device was anonymous). Each is shaped into the client-native (snake_case)
 * wire snapshot **byte-identical to the sync-journal decorator's** so the
 * backfilled `outbox.data` matches a journaled row exactly: notes and playlist
 * items go through the shared `rowMappers` (`rowToNote` / `rowToPlaylistItem`)
 * and are projected with the same field set the decorator uses; a session's
 * snapshot is the raw row shape the decorator already emits.
 *
 * The `NOT EXISTS` anti-join is the idempotency guard: once a row is enqueued
 * it owns an outbox entry and drops out of the candidate set, so a second pass
 * returns nothing. Reads only; the enclosing reentrant unit-of-work (opened by
 * the use case) owns the transaction.
 */
export function createSqlSyncBackfillRepository(db: IDatabase): ISyncBackfillRepository {
  return {
    async listUnsynced(): Promise<readonly BackfillCandidate[]> {
      const out: BackfillCandidate[] = []

      // notes — doc_id is the row id.
      const noteRows = await db.query<NoteRow>(
        `SELECT n.* FROM notes n
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'notes' AND o.doc_id = n.id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'notes' AND s.doc_id = n.id)`
      )
      for (const row of noteRows) {
        out.push({ collection: "notes", docId: row.id, data: noteWire(row) })
      }

      // playlist_items — doc_id is the natural key track_id, NOT the local
      // pl_… surrogate. A track present under several surrogate rows collapses
      // to one document (latest added_at wins), mirroring the merge key.
      const playlistRows = await db.query<PlaylistItemRow>(
        `SELECT p.* FROM playlist_items p
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'playlist_items' AND o.doc_id = p.track_id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'playlist_items' AND s.doc_id = p.track_id)`
      )
      const latestByTrack = new Map<string, PlaylistItemRow>()
      for (const row of playlistRows) {
        const prev = latestByTrack.get(row.track_id)
        if (!prev || row.added_at > prev.added_at) latestByTrack.set(row.track_id, row)
      }
      for (const row of latestByTrack.values()) {
        out.push({ collection: "playlist_items", docId: row.track_id, data: playlistWire(row) })
      }

      // listening_sessions — doc_id is the row id (grow-only union).
      const sessionRows = await db.query<ListeningSessionRow>(
        `SELECT l.* FROM listening_sessions l
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'listening_sessions' AND o.doc_id = l.id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'listening_sessions' AND s.doc_id = l.id)`
      )
      for (const row of sessionRows) {
        out.push({ collection: "listening_sessions", docId: row.id, data: sessionWire(row) })
      }

      return out
    },
  }
}

/* --- client-native (snake_case) row snapshots for outbox.data ---
 *
 * These MUST stay byte-identical to the private wire builders in
 * `syncJournalDecorator.ts` (that lane owns them and can't be edited here) so a
 * backfilled row is indistinguishable from a journaled one on the wire. notes /
 * playlist reuse the shared row→domain mappers (`rowToNote` /
 * `rowToPlaylistItem`) exactly as the decorator does; a session snapshot is the
 * raw-row projection the decorator emits. */

function noteWire(row: NoteRow) {
  const note = rowToNote(row)
  return {
    id: note.id,
    track_id: note.trackId,
    text: note.text,
    time_start: note.timeStart,
    time_end: note.timeEnd,
    created_at: note.createdAt,
    meta: note.meta,
  }
}

function playlistWire(row: PlaylistItemRow) {
  const item = rowToPlaylistItem(row)
  return {
    id: item.id,
    track_id: item.trackId,
    added_at: item.addedAt,
    archived_at: item.archivedAt,
    collection_id: item.collectionId,
  }
}

function sessionWire(row: ListeningSessionRow) {
  return {
    id: row.id,
    item_id: row.item_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    from_position: row.from_position,
    to_position: row.to_position,
  }
}
