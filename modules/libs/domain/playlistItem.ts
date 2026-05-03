import type { PlaylistItemId, TrackId, UnixMs } from "./core.js"

export interface PlaylistItem {
  readonly id: PlaylistItemId
  readonly trackId: TrackId
  readonly addedAt: UnixMs
  readonly archivedAt: UnixMs | null
}
