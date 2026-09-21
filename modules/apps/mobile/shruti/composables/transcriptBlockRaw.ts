import type { LanguageCode } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { TranscriptBlock } from "@lib/domain/transcript.js"

/** Every block the reader renders — a paragraph marker is a break, not a block. */
type RenderableBlock = Exclude<TranscriptBlock, { type: "paragraph" }>
import type { UiTranscriptBlockRaw } from "@ui/features/transcript/index.js"
import { formatReference, formatReferenceFull } from "@lib/domain/services/references.js"

export interface RawBlockContext {
  readonly sourcesById?: ReadonlyMap<string, Source>
  readonly lang: LanguageCode
  /** Speaker of the previous sentence — drives the speaker-change dash. */
  readonly lastSpeaker?: string
}

/** Mirror one domain block into the shape the renderer consumes. */
export function toRawBlock(block: RenderableBlock, ctx: RawBlockContext): UiTranscriptBlockRaw {
  if (block.type === "sentence") {
    return {
      type: "sentence",
      start: block.start,
      end: block.end,
      text: block.text,
      speaker: block.speaker,
      speakerChanged: block.speaker !== undefined && block.speaker !== ctx.lastSpeaker,
      // Sentence-block references render as an inline / floating chip, so use
      // the SHORT name.
      reference: block.reference
        ? formatReference(block.reference, ctx.sourcesById, ctx.lang)
        : undefined,
    }
  }

  if (block.type === "verse:text") {
    return {
      type: "verse:text",
      start: block.start,
      end: block.end,
      text: block.text,
      // The renderer splits verse:text by line count: multi-line goes to the
      // centered chip (room for the FULL name), single-line to the floating
      // chip (SHORT name).
      reference: block.reference
        ? block.text.length > 1
          ? formatReferenceFull(block.reference, ctx.sourcesById, ctx.lang)
          : formatReference(block.reference, ctx.sourcesById, ctx.lang)
        : undefined,
      original: block.original,
      translation: block.translation,
    }
  }

  if (block.type === "verse:translation") {
    return { type: "verse:translation", start: block.start, end: block.end, text: block.text }
  }

  return {
    type: "marker",
    start: block.start,
    end: block.end,
    text: block.text,
    speaker: block.speaker,
  }
}
