/** Pure UI types for Transcript presentation components. */

export interface BlockReference {
  sourceId?: string
  sourceName?: string
  tokens: string[]
  label?: string
  original?: string[]
  transliteration?: string[]
  translation?: string
}

export interface SentenceBlock {
  type: "sentence"
  start: number
  end: number
  text: string
  speaker?: string
  reference?: BlockReference
}

export interface VerseTextBlock {
  type: "verse:text"
  start: number
  end: number
  text: string[]
  reference?: BlockReference
  original?: string[]
  translation?: string
}

export interface VerseTranslationBlock {
  type: "verse:translation"
  start: number
  end: number
  text: string
}

export interface ParagraphBlock {
  type: "paragraph"
  start: number
  end: number
}

export interface MarkerBlock {
  type: "marker"
  start: number
  end: number
  text: string
  speaker?: string
}

export type TranscriptBlock =
  | SentenceBlock
  | VerseTextBlock
  | VerseTranslationBlock
  | ParagraphBlock
  | MarkerBlock

export interface TranscriptGroup {
  heading?: string
  headingStartMs?: number
  startMs: number
  endMs: number
  blocks: TranscriptBlock[]
}
