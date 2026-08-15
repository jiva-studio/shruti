/**
 * UI mirror of a note row rendered in NotesList. Controllers flatten the
 * domain Note into this shape and join the surrounding track metadata
 * (author / title / date / location / reference) so the list item can
 * show the user where the note came from.
 *
 * `text` may contain `<mark>` markup injected by the controller for
 * search-match highlighting — NotesListItem renders it via `v-html`.
 * The controller is responsible for escaping the user-supplied content
 * before wrapping matches.
 */
export interface UiNoteRow {
  readonly id: string
  /** Possibly HTML — caller is responsible for escaping + match wrapping. */
  readonly text: string
  readonly trackId: string
  readonly language: string
  /** Anchor timestamps (seconds) — kept for future seek-from-note flows. */
  readonly timeStart: number
  readonly timeEnd: number
  readonly createdAt: number
  /** Localised author display name; absent when the track has no author. */
  readonly authorName?: string
  /** Track variant title in the active UI language (fallback to first variant). */
  readonly trackTitle?: string
  /** Lecture date, already localized by the controller (`formatTrackDate`). */
  readonly trackDate?: string
  /** Localised location name. */
  readonly locationName?: string
  /** Pre-formatted scripture reference (e.g. "BG 2.13"). */
  readonly reference?: string
  /**
   * Storage path of the source track audio. Forwarded by the composition
   * root so the caller can render an inline excerpt player above the
   * quote without the UI layer reaching into the track domain itself.
   * Absent when the track has no audio variant.
   */
  readonly audioPath?: string
  /**
   * The lecture behind this note is not in the catalog any more (hidden or
   * dropped), so every track-derived field above is absent. The note itself
   * is still the user's own text and stays on screen; what the host must
   * suppress is anything that pretends to act on the lecture — the inline
   * player would render a fully enabled play button that does nothing.
   */
  readonly trackUnresolved?: boolean
}
