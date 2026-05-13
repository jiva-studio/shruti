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

export interface UiTranscriptBlockView {
  readonly block: UiTranscriptBlockRaw
  readonly language: string
  /** Optional speaker emoji/icon rendered in the sentence gutter. */
  readonly icon?: string
  bookmarked: boolean
}

export interface UiTranscriptBlocksGroup {
  readonly blocks: UiTranscriptBlockView[]
}

/** @deprecated alias kept while existing consumers migrate to groups. */
export type UiTranscriptBlock = UiTranscriptBlockRaw
