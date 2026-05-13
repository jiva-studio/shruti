/**
 * UI mirror of a note row rendered in NotesList. Controllers flatten the
 * domain Note into this shape.
 *
 * `language` drives the locale-aware highlight rendering in
 * NotesListItem. If a future surface (share sheet, action header) needs
 * author/source/tags they should be added here AND wired through the
 * controller — the previous "for future use" fields were never sourced
 * and the controller hardcoded them to empty.
 */
export interface UiNoteRow {
  readonly id: string
  readonly text: string
  readonly trackId: string
  readonly language: string
  /** Anchor timestamps (seconds) — kept for future seek-from-note flows. */
  readonly timeStart: number
  readonly timeEnd: number
  readonly createdAt: number
}
