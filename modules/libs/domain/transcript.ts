import type { LanguageCode, TrackId } from "./core.js"
import type { Reference } from "./reference.js"

/**
 * Transcript — a time-aligned sequence of blocks. Fetched as JSON from
 * public S3; never stored in the SQLite DB.
 */
export interface Transcript {
  readonly trackId: TrackId
  readonly language: LanguageCode
  readonly version: number
  readonly blocks: readonly TranscriptBlock[]
}

export type TranscriptBlock =
  | TranscriptParagraphBlock
  | TranscriptSentenceBlock
  | TranscriptVerseTextBlock
  | TranscriptVerseTranslationBlock
  | TranscriptMarkerBlock

export interface TranscriptParagraphBlock {
  readonly type: "paragraph"
  readonly start: number
  readonly end: number
}

export interface TranscriptSentenceBlock {
  readonly type: "sentence"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
  readonly reference?: Reference
}

export interface TranscriptVerseTextBlock {
  readonly type: "verse:text"
  readonly start: number
  readonly end: number
  readonly text: readonly string[]
  readonly reference?: Reference
}

export interface TranscriptVerseTranslationBlock {
  readonly type: "verse:translation"
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface TranscriptMarkerBlock {
  readonly type: "marker"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly speaker?: string
}
