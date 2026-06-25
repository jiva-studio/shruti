import type {
  ChatVerseBody,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatOutlinePayload,
} from '@lib/domain/chatMessage.js'

export type VersePayload = ChatVerseBody
export type ChapterPayload = ChatChapterBody
export type CitationPayload = ChatCiteSnippet
export type CommentaryPayload = ChatCommentaryBody
export type OutlinePayload = ChatOutlinePayload

export interface CardReference {
  sourceId?: unknown
  tokens?: unknown
  label?: unknown
}

/** Whole-lecture card attribution (a `[card:<track_id>]` tile). Resolved
 *  server-side for clients with no local catalog (web). */
export interface CardPayload {
  trackId: string
  trackTitle?: unknown
  authorName?: unknown
  trackDate?: unknown
  references?: CardReference[]
}

export interface PdfItemPayload {
  track_id?: string
  trackId?: string
  title?: string
  lang?: string
}

export interface PdfActionPayload {
  items?: PdfItemPayload[]
}

export interface ResearchSource {
  kind?: string
  id: string
  label: string
}
