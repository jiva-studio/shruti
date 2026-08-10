/**
 * Indicator state for a track in any list (search results, playlist, notes).
 *
 * - "added"      — in playlist or downloaded; one checkmark (icon mode).
 * - "queued"     — in playlist, not currently active; radial with playback progress.
 * - "playing"    — track is actively playing; radial with playback progress.
 * - "completed"  — track listened to the end; two checkmarks.
 * - "downloading" — radial with download progress.
 * - "pending"    — tap accepted, outcome unknown yet; shimmer.
 * - "failed"     — download failed; warning icon.
 * - "none"       — neutral.
 */
export type UiTrackState =
  | "none"
  | "failed"
  | "added"
  /** In the playlist, but the storage budget refused to save it offline. */
  | "deferred"
  | "queued"
  | "completed"
  | "pending"
  | "downloading"
  | "playing"
