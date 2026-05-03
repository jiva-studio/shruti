import type { MediaItem, MediaItemState } from "@lib/domain/mediaItem.js"
import type { Note } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { MediaItemRow, NoteRow, PlaylistItemRow } from "@lib/persistence/user"

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
  }
}

export function rowToPlaylistItem(row: PlaylistItemRow): PlaylistItem {
  return {
    id: row.id,
    trackId: row.track_id,
    addedAt: row.added_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    progress: row.progress,
  }
}

export function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    trackId: row.track_id,
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
