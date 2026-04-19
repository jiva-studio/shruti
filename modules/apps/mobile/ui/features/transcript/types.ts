/**
 * UI mirror of the domain transcript types. @ui cannot import from
 * @lib/domain — the view controller converts domain blocks to these
 * shapes. Keep them structurally compatible with
 * `@lib/domain/transcript.ts`; if the domain type changes, update this
 * mirror + the builder at the same time.
 */

export type UiTranscriptBlock =
  | UiTranscriptParagraphBlock
  | UiTranscriptSentenceBlock
  | UiTranscriptVerseTextBlock
  | UiTranscriptVerseTranslationBlock

export interface UiTranscriptParagraphBlock {
  readonly type: "paragraph"
  readonly start: number
  readonly end: number
}

export interface UiTranscriptSentenceBlock {
  readonly type: "sentence"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
}

export interface UiTranscriptVerseTextBlock {
  readonly type: "verse:text"
  readonly start: number
  readonly end: number
  readonly text: readonly string[]
}

export interface UiTranscriptVerseTranslationBlock {
  readonly type: "verse:translation"
  readonly start: number
  readonly end: number
  readonly text: string
}
