import type { MediaItemId, TrackId, UnixMs } from "./core.js"

export type MediaItemState = "pending" | "downloading" | "ready" | "failed"

/**
 * Offline media cache entry: tracks the local filesystem state for a
 * track's audio file after an explicit user-initiated download.
 */
export interface MediaItem {
  readonly id: MediaItemId
  readonly trackId: TrackId
  readonly state: MediaItemState
  readonly localPath: string | null
  readonly createdAt: UnixMs
}
