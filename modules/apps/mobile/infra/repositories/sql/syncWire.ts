import type { NoteRow, PlaylistItemRow, ListeningSessionRow } from "@lib/persistence/user"
import { rowToNote, rowToPlaylistItem } from "./rowMappers.js"

/**
 * The single, shared set of client-native (snake_case) wire snapshots for the
 * synced user-data collections — the one place a `user.db` row is turned into
 * the JSON pushed into `outbox.data` / compared during conflict resolution.
 *
 * There used to be a hand-written copy per sync path — the journal decorator
 * (live finish), the backfill adapter (first sync), and the apply adapter
 * (re-snapshotting a local row to merge/re-push) — and they drifted:
 *   - the backfill session snapshot omitted `track_id` entirely, so every
 *     backfilled session lost its track attribution on the server;
 *   - the apply `noteRowToWire` shipped `meta` as the raw DB **string** while
 *     the push wire ships it as a parsed **object**, so a note that won a
 *     last-write-wins conflict was re-pushed double-encoded.
 * Same row, several serializers, disagreeing. These builders are the one path
 * they now share, so the shapes can't drift again.
 *
 * `meta` is emitted as the parsed object (via `rowToNote`), matching what the
 * journal decorator writes from the domain `Note`; the apply upsert tolerates
 * either a string or an object, but the canonical wire form is the object.
 */

export interface NoteWire {
  id: string
  track_id: string
  text: string
  time_start: number
  time_end: number
  created_at: number
  meta: unknown
}

export interface PlaylistWire {
  id?: string
  track_id: string
  added_at: number
  archived_at: number | null
  collection_id: string | null
}

export interface SessionWire {
  id: string
  item_id: string
  /** Natural cross-device key: the stable catalog track this session played,
   *  resolved from the playlist item. Carried so a session pulled on another
   *  device (whose `item_id` is a meaningless remote `pl_…` surrogate)
   *  re-attaches to the correct LOCAL playlist item and stays in the progress /
   *  heatmap JOINs. `null` only when the playlist item is already gone (track
   *  removed) — the one case attribution genuinely cannot be recovered. */
  track_id: string | null
  started_at: number
  ended_at: number
  from_position: number
  to_position: number
}

export function noteRowToWire(row: NoteRow): NoteWire {
  const note = rowToNote(row)
  return {
    id: note.id,
    track_id: note.trackId,
    text: note.text,
    time_start: note.timeStart,
    time_end: note.timeEnd,
    created_at: note.createdAt,
    // Parsed object (not the raw DB string) — the canonical wire form.
    meta: note.meta,
  }
}

export function playlistRowToWire(row: PlaylistItemRow): PlaylistWire {
  const item = rowToPlaylistItem(row)
  return {
    id: item.id,
    track_id: item.trackId,
    added_at: item.addedAt,
    archived_at: item.archivedAt,
    collection_id: item.collectionId,
  }
}

/**
 * Serialize a session row into its wire snapshot. `track_id` is the value
 * resolved via `LEFT JOIN playlist_items pi ON pi.id = ls.item_id` (the local
 * `listening_sessions` table stores only `item_id`, never a track); pass it in
 * alongside the row. All three sync paths MUST feed a JOIN-resolved track here.
 */
export function sessionRowToWire(
  row: ListeningSessionRow & { track_id?: string | null }
): SessionWire {
  return {
    id: row.id,
    item_id: row.item_id,
    track_id: row.track_id ?? null,
    started_at: row.started_at,
    ended_at: row.ended_at,
    from_position: row.from_position,
    to_position: row.to_position,
  }
}

export interface ChatSessionWire {
  id: string
  title: string | null
  created_at: number
  updated_at: number
  track_id: string | null
}

export interface ChatMessageWire {
  id: string
  session_id: string
  role: string
  content: string
  created_at: number
  /** The versioned `{_v, data}` envelope, verbatim as persisted (a raw string,
   *  NOT parsed) so a receiving device tolerates another device's `_v` on
   *  apply. Unlike note `meta`, the chat wire form is deliberately the string. */
  meta: string | null
}

export function chatSessionRowToWire(row: ChatSessionWire): ChatSessionWire {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    track_id: row.track_id,
  }
}

export function chatMessageRowToWire(row: ChatMessageWire): ChatMessageWire {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    meta: row.meta,
  }
}
