/**
 * Indicator state for a track in any list (search results, playlist, notes).
 *
 * - "added"      — in playlist or downloaded; one checkmark (icon mode).
 * - "queued"     — in playlist, not currently active; radial with playback progress.
 * - "playing"    — track is actively playing; radial with playback progress.
 * - "completed"  — track listened to the end; two checkmarks.
 * - "downloading" — radial with download progress.
 * - "failed"     — download failed; warning icon.
 * - "none"       — neutral.
 */
export type UiTrackState =
  | "none"
  | "failed"
  | "added"
  | "queued"
  | "completed"
  | "downloading"
  | "playing"
