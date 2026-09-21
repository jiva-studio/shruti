import type { NoteId } from "@lib/domain/core.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TranscriptBlock } from "@lib/domain/transcript.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type { UiTranscriptBlocksGroup } from "@ui/features/transcript/index.js"
import { timeRangesIntersect } from "@ui/features/transcript/timeRange.js"

/** Note range in **milliseconds** — the same unit as a transcript block. */
export interface NoteRangeMs {
  readonly id?: NoteId
  readonly start: number
  readonly end: number
}

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

/** Notes overlapping a block, by the same half-open predicate the live
 *  drag-selection highlight uses. */
export function collectNoteOverlap(
  ranges: readonly NoteRangeMs[],
  start: number,
  end: number
): { bookmarked: boolean; noteIds: readonly NoteId[] } {
  const noteIds: NoteId[] = []
  let bookmarked = false
  for (const range of ranges) {
    if (!timeRangesIntersect({ start, end }, range)) continue
    bookmarked = true
    if (range.id !== undefined) noteIds.push(range.id)
  }
  return { bookmarked, noteIds }
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

/**
 * A chapter starting after the last block never triggered a split — attach the
 * last such one to the final group so it still renders a heading and a scroll
 * anchor instead of vanishing from the reader.
 */
export function attachTrailingChapter(
  groups: UiTranscriptBlocksGroup[],
  trailing: readonly ChapterHeading[]
): void {
  const last = groups[groups.length - 1]
  if (trailing.length === 0 || last === undefined || last.heading !== undefined) return
  const chapter = trailing[trailing.length - 1]
  groups[groups.length - 1] = { ...last, heading: chapter.title, headingStartMs: chapter.startMs }
}

/** Post-pass for the sentence-paired layout: the grouper emitted one sentence per
 *  group in (time, language) order, so — because the transcripts are aligned 1:1
 *  — every N consecutive groups are the SAME sentence in the N languages. Merge
 *  each such run into one group, ordered by the transcripts' order (source first).
 *  Index-based (not exact-timestamp) so a small timing drift between the original
 *  and its translation still pairs them. */
export function pairSentenceGroups(
  groups: readonly UiTranscriptBlocksGroup[],
  langOrder: readonly LanguageCode[]
): readonly UiTranscriptBlocksGroup[] {
  const n = Math.max(1, langOrder.length)
  const out: UiTranscriptBlocksGroup[] = []
  for (let i = 0; i < groups.length; i += n) {
    const cluster = groups.slice(i, i + n)
    const blocks = cluster
      .flatMap((g) => g.blocks)
      .slice()
      .sort((a, b) => langOrder.indexOf(a.language) - langOrder.indexOf(b.language))
    out.push({
      blocks,
      heading: cluster.find((g) => g.heading !== undefined)?.heading,
      headingStartMs: cluster.find((g) => g.headingStartMs !== undefined)?.headingStartMs,
      paired: blocks.length > 1,
    })
  }
  return out
}
