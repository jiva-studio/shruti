import type { LanguageCode } from "@lib/domain/core.js"
import type { TranscriptBlock } from "@lib/domain/transcript.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"

export interface ParagraphBreakState {
  readonly hasCurrent: boolean
  readonly charsAccum: number
  readonly lastLanguage: LanguageCode | undefined
  readonly blockLanguage: LanguageCode
}

/**
 * Does this block open a fresh paragraph before it is pushed? Sentences stay
 * atomic, so the cut lands between them; a merged multi-language view also
 * breaks whenever the language changes, so a paragraph never mixes two.
 */
export function startsNewParagraph(
  block: TranscriptBlock,
  opts: { readonly paragraphChars: number; readonly breakOnLanguageChange?: boolean },
  state: ParagraphBreakState
): boolean {
  if (!state.hasCurrent) return false
  if (opts.breakOnLanguageChange && state.blockLanguage !== state.lastLanguage) return true
  return (
    block.type === "sentence" &&
    opts.paragraphChars > 0 &&
    state.charsAccum + block.text.length > opts.paragraphChars
  )
}

export interface ChapterHeading {
  readonly title: string
  readonly startMs: number
}

export interface ChapterCursor {
  /** The chapter a block at `startMs` opens, if any. Several chapters falling
   *  before the same block collapse to the last one. */
  take: (startMs: number) => ChapterHeading | undefined
  /** Chapters that start after the last block and never triggered a split. */
  remaining: () => readonly ChapterHeading[]
}

export function createChapterCursor(
  chapters: readonly TrackOutlineChapter[] | undefined
): ChapterCursor {
  const list = (chapters ?? [])
    .filter((c) => Number.isFinite(c.startMs))
    .map((c) => ({ title: c.title, startMs: c.startMs }))
    .sort((a, b) => a.startMs - b.startMs)
  let idx = 0
  return {
    take(startMs) {
      let triggered: ChapterHeading | undefined
      while (idx < list.length && startMs >= list[idx].startMs) {
        triggered = list[idx]
        idx++
      }
      return triggered
    },
    remaining: () => list.slice(idx),
  }
}
