import type { LanguageCode, NoteId } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { Transcript } from "@lib/domain/transcript.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type {
  UiTranscriptBlockRaw,
  UiTranscriptBlockView,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"
import { formatReference, formatReferenceFull } from "@lib/domain/services/references.js"

/**
 * One saved note's time range, in **milliseconds** — same unit as the
 * transcript blocks' `start`/`end`. Notes are written to the DB with the
 * exact ms values the drag-selection emits (the drag reads
 * `data-time-start` which is already `block.start` in ms), so no unit
 * conversion happens anywhere in the path; the overlap check below is a
 * direct integer comparison.
 *
 * `id` is optional so preview callers can synthesize ranges without a
 * full `Note` shape; the controller's real-note path always passes the
 * id, which then flows into each overlapping block's `noteIds` for the
 * tap-on-highlight Delete affordance.
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
   * Saved notes for the current track. Any block whose `[start..end]`
   * (ms) overlaps any note range (also ms — see `NoteRange`) is rendered
   * with `bookmarked: true`, which drives the highlight underline.
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

  const groups: UiTranscriptBlocksGroup[] = []
  let current: UiTranscriptBlockView[] = []
  let lastSpeaker: string | undefined = undefined
  let charsAccum = 0

  // Outline chapters sorted by start; `chapterIdx` walks forward as blocks
  // advance in time. `currentHeading` is the chapter that opened the group
  // being accumulated — it gets stamped onto that group when it flushes.
  const chapterList = (opts.chapters ?? [])
    .filter((c) => Number.isFinite(c.startMs))
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
  let chapterIdx = 0
  let currentHeading: { title: string; startMs: number } | undefined = undefined

  const lang: LanguageCode = opts.lang ?? "en"
  const sourcesById = opts.sourcesById
  // Snapshot note ranges into the loop-local shape once. Both note
  // timestamps and block timestamps are in ms (see `NoteRange`), so the
  // comparison below is a direct integer overlap test — no unit
  // conversion required. Empty array → nothing gets marked bookmarked.
  // Carry the optional id through so the per-block overlap pass can
  // collect every matching note id into the block's `noteIds`.
  const noteRangesMs: readonly { id?: NoteId; start: number; end: number }[] = (
    opts.notes ?? []
  ).map((n) => ({
    id: n.id,
    start: n.timeStart,
    end: n.timeEnd,
  }))

  const collectOverlap = (
    blockStart: number,
    blockEnd: number
  ): { bookmarked: boolean; noteIds: readonly NoteId[] } => {
    let bookmarked = false
    let ids: NoteId[] | null = null
    for (const r of noteRangesMs) {
      // Standard interval overlap: not disjoint on either side.
      if (blockStart <= r.end && blockEnd >= r.start) {
        bookmarked = true
        if (r.id !== undefined) {
          if (ids === null) ids = []
          ids.push(r.id)
        }
      }
    }
    return { bookmarked, noteIds: ids ?? [] }
  }

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
    charsAccum = 0
    // The heading belongs to the group just flushed; the next group starts
    // headless until another chapter boundary opens one.
    currentHeading = undefined
  }

  for (const block of transcript.blocks) {
    if (block.type === "paragraph") {
      flush()
      continue
    }

    // Outline boundary: if this block is the first to reach the next
    // chapter's start, close the running paragraph and open a fresh group
    // tagged with that chapter (even if the boundary lands mid-paragraph —
    // the chapter wins and starts a new block here). Multiple chapters that
    // fall before this block collapse to the last one.
    let triggered: { title: string; startMs: number } | undefined
    while (chapterIdx < chapterList.length && block.start >= chapterList[chapterIdx].startMs) {
      triggered = { title: chapterList[chapterIdx].title, startMs: chapterList[chapterIdx].startMs }
      chapterIdx++
    }
    if (triggered) {
      flush()
      currentHeading = triggered
    }

    // Threshold check BEFORE the push: if adding this sentence would
    // push the paragraph past `paragraphChars`, start a fresh paragraph
    // now. Sentences stay atomic; the cut lands between them.
    if (
      block.type === "sentence" &&
      opts.paragraphChars > 0 &&
      current.length > 0 &&
      charsAccum + block.text.length > opts.paragraphChars
    ) {
      flush()
    }

    const raw: UiTranscriptBlockRaw =
      block.type === "sentence"
        ? {
            type: "sentence",
            start: block.start,
            end: block.end,
            text: block.text,
            speaker: block.speaker,
            speakerChanged: block.speaker !== undefined && block.speaker !== lastSpeaker,
            // Sentence-block references render as an inline / floating chip
            // (VerseTextInlineBlock-style placement), so use the SHORT name.
            reference: block.reference
              ? formatReference(block.reference, sourcesById, lang)
              : undefined,
          }
        : block.type === "verse:text"
          ? {
              type: "verse:text",
              start: block.start,
              end: block.end,
              text: block.text,
              // The renderer (TranscriptBlockRenderer.vue) splits verse:text
              // by line count: multi-line goes to VerseTextBlock (centered
              // chip — room for the FULL name), single-line goes to
              // VerseTextInlineBlock (floating chip — SHORT name).
              reference: block.reference
                ? block.text.length > 1
                  ? formatReferenceFull(block.reference, sourcesById, lang)
                  : formatReference(block.reference, sourcesById, lang)
                : undefined,
            }
          : {
              type: "verse:translation",
              start: block.start,
              end: block.end,
              text: block.text,
            }

    const overlap = collectOverlap(raw.start, raw.end)
    current.push({
      block: raw,
      language: transcript.language,
      bookmarked: overlap.bookmarked,
      noteIds: overlap.noteIds,
    })

    if (block.type === "sentence") {
      lastSpeaker = block.speaker
      charsAccum += block.text.length
    }
  }

  flush()

  // Trailing chapter(s) whose start lands after the last block's start never
  // triggered a split (no later block to cross the boundary). Attach the last
  // such chapter to the final group so it still renders a heading + scroll
  // anchor instead of silently vanishing from the reader.
  if (chapterIdx < chapterList.length && groups.length > 0) {
    const last = groups[groups.length - 1]
    if (last.heading === undefined) {
      const ch = chapterList[chapterList.length - 1]
      groups[groups.length - 1] = { ...last, heading: ch.title, headingStartMs: ch.startMs }
    }
  }

  return groups
}

/**
 * Given a list of LanguageCodes currently available for the track, build
 * the UI mirror list expected by LanguageSelector. Falls back to the
 * code when we have no localised name.
 */
export function buildTranscriptLanguages(
  codes: readonly string[],
  resolve?: (code: string) => { name?: string; icon?: string }
): readonly UiTranscriptLanguage[] {
  return codes.map((code) => {
    const meta = resolve?.(code)
    return { code, name: meta?.name ?? code.toUpperCase(), icon: meta?.icon }
  })
}
