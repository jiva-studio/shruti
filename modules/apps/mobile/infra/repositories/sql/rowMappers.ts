import type { ListeningSession } from "@lib/domain/listeningSession.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { LibraryItem, LibraryItemOrigin, LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type {
  LibraryItemRow,
  ListeningSessionRow,
  MediaItemRow,
  NoteRow,
  PlaylistItemRow,
} from "@lib/persistence/user"

/**
 * The one and only place that knows the SQL row shapes for the user DB
 * and converts them into domain entities. Keep domain types free of
 * snake_case / NULL / string-from-DB concerns.
 */

export function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    trackId: row.track_id,
    text: row.text,
    timeStart: row.time_start,
    timeEnd: row.time_end,
    createdAt: row.created_at,
    meta: parseNoteMeta(row.meta),
  }
}

function parseNoteMeta(raw: string | null): NoteMeta | null {
  if (raw === null || raw === "") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as NoteMeta
    }
    return null
  } catch {
    // Corrupt rows shouldn't take down the notes list — log and drop.
    console.warn("[rowToNote] failed to parse meta:", raw)
    return null
  }
}

export function rowToPlaylistItem(row: PlaylistItemRow): PlaylistItem {
  return {
    id: row.id,
    trackId: row.track_id,
    addedAt: row.added_at,
    archivedAt: row.archived_at,
    collectionId: row.collection_id ?? null,
  }
}

export function rowToLibraryItem(row: LibraryItemRow): LibraryItem {
  return {
    id: row.id,
    trackId: row.track_id,
    status: narrowLibraryStatus(row.status),
    origin: narrowLibraryOrigin(row.origin),
    titleRaw: row.title_raw,
    authorRaw: row.author_raw,
    locationRaw: row.location_raw,
    dateRaw: row.date_raw,
    langHint: row.lang_hint,
    authorId: row.author_id,
    locationId: row.location_id,
    date: row.date,
    datePrecision: row.date_precision,
    lang: row.lang,
    langConfidence: row.lang_confidence,
    error: row.error,
    audioKey: row.audio_key,
    transcriptKey: row.transcript_key,
    duration: row.duration,
    coverKey: row.cover_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function narrowLibraryStatus(raw: string): LibraryItemStatus {
  switch (raw) {
    case "queued":
    case "processing":
    case "ready":
    case "failed":
      return raw
    default:
      // A status written by a newer server build must not throw and blank the
      // library list — treat an unknown value as still processing.
      console.warn(`Unexpected library_items.status value "${raw}"; treating as "processing"`)
      return "processing"
  }
}

function narrowLibraryOrigin(raw: string | null): LibraryItemOrigin | null {
  if (raw === "private" || raw === "published") return raw
  return null
}

export function rowToListeningSession(row: ListeningSessionRow): ListeningSession {
  return {
    id: row.id,
    itemId: row.item_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    fromPosition: row.from_position,
    toPosition: row.to_position,
  }
}

export function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    trackId: row.track_id,
    kind: row.kind === "clean" ? "clean" : "original",
    state: narrowMediaState(row.state),
    localPath: row.local_path,
    createdAt: row.created_at,
  }
}

function narrowMediaState(raw: string): MediaItemState {
  switch (raw) {
    case "pending":
    case "downloading":
    case "ready":
    case "failed":
      return raw
    default:
      // An unexpected state (a row written by a newer build, or a partially
      // migrated row) must not throw and blank the playlist / downloads view.
      // Fall back to "failed" — the media is treated as not available and is
      // re-downloadable — and warn, mirroring narrowAudioKind in the content
      // row mappers.
      console.warn(`Unexpected media_items.state value "${raw}"; treating as "failed"`)
      return "failed"
  }
}
