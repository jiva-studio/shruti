/**
 * UI mirror of a "track row" — the subset of Track + dictionary lookups
 * that the list renders. Controllers flatten the domain `Track` +
 * `TrackVariant` + `Author` into this shape (picking the right language).
 *
 * Fields follow the legacy block contract so the ported TrackListItem can
 * be used verbatim.
 */
export interface UiTrackRow {
  readonly id: string
  readonly title: string
  /** Author's localised full name, or empty string when unknown. */
  readonly author: string
  /** Location's localised full name, or empty string when unknown. */
  readonly location: string
  /** ISO "YYYY-MM-DD" or empty string. */
  readonly date: string
  /** Every reference stringified for display (e.g. ["sb 1.8.40"]). */
  readonly references: readonly string[]
  /** Tag display names used when no reference is present. */
  readonly tags: readonly string[]
  /** Track state indicator (drives PlaylistStateIndicator / IconIndicator). */
  readonly state: UiTrackState
  /**
   * 0..100 radial value. Its meaning depends on `state`:
   * "downloading" → download %, "playing"/"queued" → playback %, otherwise unused.
   */
  readonly progressPct: number
  readonly disabled: boolean
}

// "added"   — in playlist or downloaded; one checkmark (icon mode).
// "queued"  — in playlist, not currently active; radial with playback progress.
// "playing" — track is actively playing; radial with playback progress.
// "completed" — track listened to the end (PlaylistItem.completedAt != null); two checkmarks.
export type UiTrackState =
  | "none"
  | "failed"
  | "added"
  | "queued"
  | "completed"
  | "downloading"
  | "playing"
