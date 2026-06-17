import type { PlaylistItemId, TrackId, UnixMs } from "./core.js"

export interface PlaylistItem {
  readonly id: PlaylistItemId
  readonly trackId: TrackId
  readonly addedAt: UnixMs
  readonly archivedAt: UnixMs | null
  /**
   * The collection this track was added FROM, when the user added a whole
   * collection at once. `null` for tracks added individually. Drives the
   * Home playlist's collection grouping by stored intent rather than by
   * inferring catalog membership.
   */
  readonly collectionId: string | null
}
