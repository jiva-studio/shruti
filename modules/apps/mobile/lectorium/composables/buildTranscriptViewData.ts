import type { LanguageCode, NoteId } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { Transcript, TranscriptBlock } from "@lib/domain/transcript.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type {
  UiTranscriptBlockView,
  UiTranscriptBlocksGroup,
} from "@ui/features/transcript/index.js"
import { toRawBlock } from "@lectorium/composables/transcriptBlockRaw.js"
import {
  attachTrailingChapter,
  collectNoteOverlap,
  createChapterCursor,
  pairSentenceGroups,
  startsNewParagraph,
  type ChapterHeading,
  type NoteRangeMs,
} from "@lectorium/composables/transcriptGrouping.js"

/**
 * One saved note's time range, in **milliseconds** — the same unit as a
 * transcript block's `start`/`end`, so the overlap check is a direct integer
 * comparison. `id` is optional so preview callers can synthesize a range
 * without a full `Note`.
 */
export interface NoteRange {
  readonly id?: NoteId
  readonly timeStart: number
  readonly timeEnd: number
}

export interface BuildTranscriptViewDataOpts {
  /**
   * Auto-paragraph break threshold: when the current group's accumulated
   * sentence text length crosses this many characters, the next sentence
   * starts a fresh group. Server-emitted `paragraph` blocks always force a
   * break too — `paragraphChars` is just a fallback when the server didn't
   * mark them (which is the common case today).
   */
  readonly paragraphChars: number
  /**
   * Catalog `sources` dictionary used to localise scripture references
   * to "Bhagavad-gītā 2.13" (full) or "BG 2.13" (short). When absent or
   * missing an entry, the formatter falls back to the raw `sourceId`.
   */
  readonly sourcesById?: ReadonlyMap<string, Source>
  /** Active UI language code used to pick the right localised name. */
  readonly lang?: LanguageCode
  /**
   * Saved notes for the current track. Any block whose `[start, end)`
   * (ms) intersects any note range (also ms — see `NoteRange`) is rendered
   * with `bookmarked: true`, which drives the highlight underline. The
   * intervals are half-open, so a block that merely touches a note's edge
   * is NOT part of it — see `timeRangesIntersect`.
   * Omitted / empty means no historic highlights — used in preview mode.
   */
  readonly notes?: readonly NoteRange[]
  /**
   * Outline chapters (ms). When present, the transcript is split at every
   * chapter start: the block that first reaches a chapter's `startMs` opens
   * a fresh paragraph group tagged with that chapter's `heading`, so the
   * reader can render an inline heading there. Empty / omitted → no splits.
   */
  readonly chapters?: readonly TrackOutlineChapter[]
  /**
   * When merging multiple languages, force a fresh paragraph whenever the block
   * language changes, so a paragraph never mixes languages. Single-language
   * builds ignore it. Defaults to false (only the char threshold / markers break).
   */
  readonly breakOnLanguageChange?: boolean
  /**
   * Sentence-paired layout for a translation: emit ONE group per sentence, each
   * carrying the same sentence in every active language (source first, by the
   * `transcripts[]` order), so the reader shows the original with its translation
   * directly beneath — instead of time-merged paragraphs. Only meaningful when
   * the active transcripts are aligned 1:1 (a translation, not lecturer+translator).
   */
  readonly sentencePaired?: boolean
}

/** One block paired with the language of the transcript it came from — the unit
 *  the grouper consumes, so a merged multi-language view keeps each block's own
 *  language for hyphenation/font. */
interface LangBlock {
  readonly block: TranscriptBlock
  readonly language: LanguageCode
}

/**
 * Flattens one domain `Transcript` into UI mirror blocks, grouped by
 * paragraph. A new group starts at every server-emitted paragraph marker
 * AND whenever the running character count crosses `paragraphChars`.
 * Empty groups are dropped.
 */
export function buildTranscriptViewData(
  transcript: Transcript | null,
  opts: BuildTranscriptViewDataOpts
): readonly UiTranscriptBlocksGroup[] {
  if (!transcript) return []
  return groupLangBlocks(
    transcript.blocks.map((block) => ({ block, language: transcript.language })),
    opts
  )
}

/**
 * Merge SEVERAL per-language transcripts into one interleaved view: every
 * enabled language's blocks are combined and ordered by time, each block
 * keeping its own language. Used by the multi-language transcript viewer (a
 * lecturer+translator recording). A stable sort with a language tiebreak keeps
 * equal-start blocks in a deterministic order.
 */
export function buildMergedTranscriptViewData(
  transcripts: readonly { readonly language: LanguageCode; readonly transcript: Transcript }[],
  opts: BuildTranscriptViewDataOpts
): readonly UiTranscriptBlocksGroup[] {
  const merged: LangBlock[] = transcripts.flatMap((t) =>
    t.transcript.blocks.map((block) => ({ block, language: t.language }))
  )
  merged.sort((a, b) => a.block.start - b.block.start || a.language.localeCompare(b.language))
  const groups = groupLangBlocks(merged, opts)
  if (!opts.sentencePaired) return groups
  return pairSentenceGroups(
    groups,
    transcripts.map((t) => t.language)
  )
}

/**
 * Which of the built languages actually hold a dialogue — more than one distinct
 * speaker across their blocks. The reader's dialogue affordances (per-line
 * speaker icon, speaker-change dash + line break) are noise on a monologue,
 * which is what almost every lecture is.
 *
 * Counted per LANGUAGE, not over the whole view: in a lecturer+translator
 * recording each side is its own transcript, so a single-speaker English side
 * stays clean even when the Russian one is a conversation. A block with no
 * speaker contributes nothing — "no speaker info at all" reads as one speaker.
 */
export function multiSpeakerLanguages(
  groups: readonly UiTranscriptBlocksGroup[]
): ReadonlySet<string> {
  const byLanguage = new Map<string, Set<string>>()
  for (const group of groups) {
    for (const { block, language } of group.blocks) {
      const speaker = "speaker" in block ? block.speaker : undefined
      if (!speaker) continue
      const seen = byLanguage.get(language)
      if (seen) seen.add(speaker)
      else byLanguage.set(language, new Set([speaker]))
    }
  }
  const out = new Set<string>()
  for (const [language, speakers] of byLanguage) {
    if (speakers.size > 1) out.add(language)
  }
  return out
}

/** Core: group a time-ordered list of (block, language) into paragraph groups. */
function groupLangBlocks(
  entries: readonly LangBlock[],
  opts: BuildTranscriptViewDataOpts
): readonly UiTranscriptBlocksGroup[] {
  const groups: UiTranscriptBlocksGroup[] = []
  let current: UiTranscriptBlockView[] = []
  let lastSpeaker: string | undefined = undefined
  let lastLanguage: LanguageCode | undefined = undefined
  let charsAccum = 0

  // The chapter that opened the group being accumulated; stamped onto it when
  // the group flushes.
  const chapters = createChapterCursor(opts.chapters)
  let currentHeading: ChapterHeading | undefined = undefined

  const lang: LanguageCode = opts.lang ?? "en"
  const noteRangesMs: readonly NoteRangeMs[] = (opts.notes ?? []).map((n) => ({
    id: n.id,
    start: n.timeStart,
    end: n.timeEnd,
  }))

  const flush = () => {
    if (current.length > 0) {
      groups.push({
        blocks: current,
        heading: currentHeading?.title,
        headingStartMs: currentHeading?.startMs,
      })
    }
    current = []
    lastSpeaker = undefined
    lastLanguage = undefined
    charsAccum = 0
    // The heading belongs to the group just flushed; the next group starts
    // headless until another chapter boundary opens one.
    currentHeading = undefined
  }

  for (const { block, language: blockLang } of entries) {
    if (block.type === "paragraph") {
      flush()
      continue
    }

    const state = {
      hasCurrent: current.length > 0,
      charsAccum,
      lastLanguage,
      blockLanguage: blockLang,
    }
    if (startsNewParagraph(block, opts, state)) flush()

    // An outline boundary wins over the running paragraph: it closes it and
    // opens a fresh group tagged with that chapter, even mid-paragraph.
    const chapter = chapters.take(block.start)
    if (chapter) {
      flush()
      currentHeading = chapter
    }

    const raw = toRawBlock(block, { sourcesById: opts.sourcesById, lang, lastSpeaker })
    const overlap = collectNoteOverlap(noteRangesMs, raw.start, raw.end)
    current.push({
      block: raw,
      language: blockLang,
      bookmarked: overlap.bookmarked,
      noteIds: overlap.noteIds,
    })
    lastLanguage = blockLang

    if (block.type === "sentence") {
      lastSpeaker = block.speaker
      charsAccum += block.text.length
      // Sentence-paired: one sentence per group, so a later pass can pair each
      // sentence with its same-timestamp translation.
      if (opts.sentencePaired) flush()
    }
  }

  flush()
  attachTrailingChapter(groups, chapters.remaining())
  return groups
}
