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
  /** Playback progress 0..100, for RadialIndicator. */
  readonly progressPct: number
  readonly disabled: boolean
}

export type UiTrackState = "none" | "failed" | "added" | "completed" | "downloading" | "playing"
