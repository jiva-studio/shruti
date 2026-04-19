/**
 * UI mirror of a "track row" — the subset of Track that the list renders.
 * Controllers are responsible for flattening the domain `Track` +
 * `TrackVariant` into this shape (picking the right language).
 */
export interface UiTrackRow {
  readonly id: string
  readonly title: string
  readonly authorName: string
  readonly date: string | null
  /** Duration in milliseconds, or null if there's no audio for this row. */
  readonly durationMs: number | null
  readonly reference: string | null
}
