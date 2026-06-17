import type { ListeningSession } from "@lib/domain/listeningSession.js"
import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type {
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
      throw new Error(`Invalid media_items.state value: ${raw}`)
  }
}
