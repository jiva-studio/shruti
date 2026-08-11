import type { MediaItemId, TrackId, UnixMs } from "./core.js"

export type MediaItemState = "pending" | "downloading" | "ready" | "failed"

/** Which audio version this cache entry is for. A track may cache both. */
export type MediaAudioKind = "original" | "clean"

/**
 * Offline media cache entry: tracks the local filesystem state for one
 * audio version of a track after an explicit user-initiated download.
 * Keyed by (trackId, kind) — a track can cache the original and the
 * denoised "clean" file independently.
 */
export interface MediaItem {
  readonly id: MediaItemId
  readonly trackId: TrackId
  /** Which audio version. Persistence always sets it (migration default
   *  "original"); optional here so older fixtures/callers stay valid. */
  readonly kind?: MediaAudioKind
  readonly state: MediaItemState
  readonly localPath: string | null
  readonly createdAt: UnixMs
  /**
   * The app owes this file an eviction: the lecture left the playlist while
   * the native engine could still reach its audio, so the delete was held
   * back. Durable on purpose — the debt used to live in a `Set` in the
   * player, and a kill in that window stranded the megabytes against the
   * storage budget for the life of the install (issue #1666).
   */
  readonly evictPending?: boolean
}
