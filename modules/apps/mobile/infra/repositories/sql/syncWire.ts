import type {
  NoteRow,
  PlaylistItemRow,
  ListeningSessionRow,
  LibraryItemRow,
} from "@lib/persistence/user"
import type { Note } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Reference } from "@lib/domain/reference.js"
import {
  parseOutlineJson,
  parseRefsJson,
  rowToNote,
  rowToPlaylistItem,
  type OutlineEntryJson,
} from "./rowMappers.js"

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

/** Canonical note wire shape — the ONE definition every path funnels through.
 *  `meta` is the parsed object, not the raw DB string; the apply upsert
 *  tolerates either, but the object is the canonical wire form. */
export function noteToWire(note: Note): NoteWire {
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

/** Canonical playlist-item wire shape — the ONE definition every path uses. */
export function playlistToWire(item: PlaylistItem): PlaylistWire {
  return {
    id: item.id,
    track_id: item.trackId,
    added_at: item.addedAt,
    archived_at: item.archivedAt,
    collection_id: item.collectionId,
  }
}

/** Row entrypoints for the SQL adapters — map to domain, then the single
 *  `*ToWire` builder, so a row snapshot is byte-identical to a domain one. */
export function noteRowToWire(row: NoteRow): NoteWire {
  return noteToWire(rowToNote(row))
}

export function playlistRowToWire(row: PlaylistItemRow): PlaylistWire {
  return playlistToWire(rowToPlaylistItem(row))
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

/**
 * Client-native (snake_case) snapshot for `library_items`. This collection is
 * **pull-only** (server-owned), so there is no push/journal path — the shape
 * exists only so the apply adapter can (a) re-snapshot a local row for
 * `getLocalDoc` and (b) map the server's wire row onto columns on apply. The
 * server's projected wire row is byte-compatible with this shape.
 */
export interface LibraryItemWire {
  id: string
  track_id: string | null
  status: string
  origin: string | null
  title_raw: string | null
  author_raw: string | null
  location_raw: string | null
  date_raw: string | null
  lang_hint: string | null
  author_id: string | null
  location_id: string | null
  date: string | null
  date_precision: string | null
  lang: string | null
  lang_confidence: number | null
  error: string | null
  audio_key: string | null
  transcript_key: string | null
  duration: number | null
  cover_key: string | null
  /** Scripture references in the domain shape, as the server projects them
   *  (raw `sourceName` today, resolved `sourceId` once normalized). */
  references: readonly Reference[] | null
  /** LLM lecture overview, as the server projects it. */
  description: string | null
  /** Coarse chapter outline `[{title,start,end}]` (ms), as the server projects it. */
  outline: readonly OutlineEntryJson[] | null
  /** URL the lecture was added from, as the server projects it. */
  source_url: string | null
  created_at: number | null
  updated_at: number | null
}

export function libraryItemRowToWire(row: LibraryItemRow): LibraryItemWire {
  return {
    id: row.id,
    track_id: row.track_id,
    status: row.status,
    origin: row.origin,
    title_raw: row.title_raw,
    author_raw: row.author_raw,
    location_raw: row.location_raw,
    date_raw: row.date_raw,
    lang_hint: row.lang_hint,
    author_id: row.author_id,
    location_id: row.location_id,
    date: row.date,
    date_precision: row.date_precision,
    lang: row.lang,
    lang_confidence: row.lang_confidence,
    error: row.error,
    audio_key: row.audio_key,
    transcript_key: row.transcript_key,
    duration: row.duration,
    cover_key: row.cover_key,
    references: parseRefsJson(row.references_json),
    description: row.description,
    outline: parseOutlineJson(row.outline_json),
    source_url: row.source_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
