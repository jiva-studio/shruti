export type LangMap = Record<string, string>

export interface LectureRef {
  sourceId: string
  shortNames: LangMap
  tokens: string
}

export interface LectureIndexEntry {
  id: string
  slug: string
  date: string | null
  durationMs: number | null
  contentLanguages: string[]
  authorId: string | null
  authorNames: LangMap
  locationId: string | null
  locationNames: LangMap
  titles: LangMap
  refs: LectureRef[]
  topicIds: string[]
  hasTranscript: boolean
  hasOutline: boolean
}

export interface TopicIndexEntry {
  id: string
  slug: string
  names: LangMap
  shortNames: LangMap
  cover: string | null
  count: number
  trackIds: string[]
}

export interface CollectionIndexEntry {
  id: string
  slug: string
  names: LangMap
  descriptions: LangMap
  cover: string | null
  count: number
  trackIds: string[]
}

export interface CollectionGroupIndexEntry {
  id: string
  names: LangMap
  descriptions: LangMap
  collectionIds: string[]
}

export interface CollectionsIndex {
  groups: CollectionGroupIndexEntry[]
  collections: Record<string, CollectionIndexEntry>
}

export interface OutlineChapter {
  title: string
  startMs: number
  endMs: number
}

/** One of `sourceId` (in-library) or `sourceName` (external book) is set. */
export interface BlockReference {
  sourceId?: string
  sourceName?: string
  tokens: string[]
}

export interface SentenceBlock {
  type: 'sentence'
  start: number
  end: number
  text: string
  speaker?: string
  reference?: BlockReference
}

export interface VerseTextBlock {
  type: 'verse:text'
  start: number
  end: number
  text: string[]
  reference?: BlockReference
  original?: string[]
  translation?: string
}

export interface VerseTranslationBlock {
  type: 'verse:translation'
  start: number
  end: number
  text: string
}

export interface ParagraphBlock {
  type: 'paragraph'
  start: number
  end: number
}

export interface MarkerBlock {
  type: 'marker'
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

export interface LectureTranscript {
  version: number | null
  blocks: TranscriptBlock[]
}

export interface LectureAudio {
  url: string
  durationMs: number | null
}

export interface LectureVariant {
  title: string
  description: string | null
  outline: OutlineChapter[]
  audio: LectureAudio | null
  transcript: LectureTranscript | null
}

export interface LectureRecord {
  id: string
  slug: string
  date: string | null
  authorId: string | null
  authorNames: LangMap
  locationId: string | null
  locationNames: LangMap
  variants: Record<string, LectureVariant>
  refs: LectureRef[]
  topicIds: string[]
}

export interface TranscriptGroup {
  heading?: string
  headingStartMs?: number
  startMs: number
  endMs: number
  blocks: TranscriptBlock[]
}
