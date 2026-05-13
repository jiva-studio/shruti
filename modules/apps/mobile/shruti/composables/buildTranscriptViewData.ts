import type { LanguageCode } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { Transcript } from "@lib/domain/transcript.js"
import type {
  UiTranscriptBlockRaw,
  UiTranscriptBlockView,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"
import { formatReference, formatReferenceFull } from "./groupReferences.js"

/**
 * One saved note's time range, in **milliseconds** — same unit as the
 * transcript blocks' `start`/`end`. Notes are written to the DB with the
 * exact ms values the drag-selection emits (the drag reads
 * `data-time-start` which is already `block.start` in ms), so no unit
 * conversion happens anywhere in the path; the overlap check below is a
 * direct integer comparison.
 */
export interface NoteRange {
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

  const lang: LanguageCode = opts.lang ?? "en"
  const sourcesById = opts.sourcesById
  // Snapshot note ranges into the loop-local shape once. Both note
  // timestamps and block timestamps are in ms (see `NoteRange`), so the
  // comparison below is a direct integer overlap test — no unit
  // conversion required. Empty array → nothing gets marked bookmarked.
  const noteRangesMs: readonly { start: number; end: number }[] = (opts.notes ?? []).map((n) => ({
    start: n.timeStart,
    end: n.timeEnd,
  }))

  const isBookmarked = (blockStart: number, blockEnd: number): boolean => {
    for (const r of noteRangesMs) {
      // Standard interval overlap: not disjoint on either side.
      if (blockStart <= r.end && blockEnd >= r.start) return true
    }
    return false
  }

  const flush = () => {
    if (current.length > 0) groups.push({ blocks: current })
    current = []
    lastSpeaker = undefined
    charsAccum = 0
  }

  for (const block of transcript.blocks) {
    if (block.type === "paragraph") {
      flush()
      continue
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

    current.push({
      block: raw,
      language: transcript.language,
      bookmarked: isBookmarked(raw.start, raw.end),
    })

    if (block.type === "sentence") {
      lastSpeaker = block.speaker
      charsAccum += block.text.length
    }
  }

  flush()
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
