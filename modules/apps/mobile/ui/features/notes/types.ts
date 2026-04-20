/**
 * UI mirror of a note row rendered in NotesList. Controllers flatten the
 * domain Note + its referring Track into this shape.
 */
export interface UiNoteRow {
  readonly id: string
  readonly text: string
  readonly trackId: string
  /** Localised author name for display in the ported action sheet. */
  readonly author: string
  /** Track title for display in share sheet header. */
  readonly source: string
  readonly language: string
  readonly tags: readonly string[]
  /** Anchor timestamps (seconds) — kept for future seek-from-note flows. */
  readonly timeStart: number
  readonly timeEnd: number
  readonly createdAt: number
}
