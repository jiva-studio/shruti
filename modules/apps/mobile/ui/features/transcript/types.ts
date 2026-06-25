/**
 * UI mirror types for the transcript view. The composition root
 * (`buildTranscriptViewData`) maps `@lib/domain/transcript` shapes into
 * these so the UI stays framework- and domain-agnostic.
 */

export interface UiTranscriptLanguage {
  readonly code: string
  readonly name: string
  readonly icon?: string
}

export type UiTranscriptBlockRaw =
  | UiTranscriptSentenceBlock
  | UiTranscriptVerseTextBlock
  | UiTranscriptVerseTranslationBlock
  | UiTranscriptMarkerBlock

export interface UiTranscriptSentenceBlock {
  readonly type: "sentence"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
  readonly speakerChanged?: boolean
  readonly reference?: string
}

export interface UiTranscriptVerseTextBlock {
  readonly type: "verse:text"
  readonly start: number
  readonly end: number
  readonly text: readonly string[]
  readonly reference?: string
}

export interface UiTranscriptVerseTranslationBlock {
  readonly type: "verse:translation"
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface UiTranscriptMarkerBlock {
  readonly type: "marker"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
}

export interface UiTranscriptBlockView {
  readonly block: UiTranscriptBlockRaw
  readonly language: string
  /** Optional speaker emoji/icon rendered in the sentence gutter. */
  readonly icon?: string
  bookmarked: boolean
  /**
   * Ids of the saved notes whose time-range overlaps this block. Empty
   * when `bookmarked` is false; non-empty when the block sits inside one
   * or more saved notes. Populated by `buildTranscriptViewData` during
   * the same overlap pass that sets `bookmarked`, so tap-on-highlight in
   * the transcript can dispatch a Delete action without re-doing the
   * lookup.
   */
  noteIds: readonly string[]
}

export interface UiTranscriptBlocksGroup {
  readonly blocks: UiTranscriptBlockView[]
  /**
   * Outline chapter title that begins at this paragraph. Set on the first
   * group whose blocks cross a chapter's start time, so the reader can
   * render a heading inline above the paragraph. Absent on every other group.
   */
  readonly heading?: string
  /** Start time (ms) of that chapter — lets a tap on the heading seek there. */
  readonly headingStartMs?: number
}
