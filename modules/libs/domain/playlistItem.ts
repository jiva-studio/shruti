import type { PlaylistItemId, TrackId, UnixMs } from "./core.js"

export interface PlaylistItem {
  readonly id: PlaylistItemId
  readonly trackId: TrackId
  readonly addedAt: UnixMs
  readonly completedAt: UnixMs | null
  readonly archivedAt: UnixMs | null
  /** Playback position in milliseconds, or null if never played. */
  readonly progress: number | null
}
