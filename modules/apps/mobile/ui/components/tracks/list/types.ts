import type { UiTrackState } from "../state/types.js"

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
  /** Pre-formatted audio length ("M:SS" / "H:MM:SS"); undefined when the
   *  track has no playable audio. Shown only by the optional "duration"
   *  metadata field. */
  readonly duration?: string
  /** Track state indicator (drives TrackStateIndicator / IconIndicator). */
  readonly state: UiTrackState
  /**
   * 0..100 radial value. Its meaning depends on `state`:
   * "downloading" → download %, "playing"/"queued" → playback %, otherwise unused.
   */
  readonly progressPct: number
  /**
   * 1-based place in the set the row is being shown as part of — a lecture
   * inside a collection. Absent everywhere else: a search hit or a topic
   * listing has no running order to state.
   */
  readonly position?: number
  readonly disabled: boolean
  /**
   * Visual dim only — applies opacity but does NOT block taps. Used so a
   * failed-download row reads as "something is off" while still being
   * tappable to retry. `disabled` remains the hard non-interactive flag.
   */
  readonly dimmed: boolean
}

export type { UiTrackState }
