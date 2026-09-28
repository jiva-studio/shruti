import type { NoteId } from "@lib/domain/core.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { UiTranscriptBlocksGroup } from "@ui/features/transcript/index.js"
import { timeRangesIntersect } from "@ui/features/transcript/timeRange.js"
import type { ChapterHeading } from "@usecases/playback/transcriptLayout.js"

/** Note range in **milliseconds** — the same unit as a transcript block. */
export interface NoteRangeMs {
  readonly id?: NoteId
  readonly start: number
  readonly end: number
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
