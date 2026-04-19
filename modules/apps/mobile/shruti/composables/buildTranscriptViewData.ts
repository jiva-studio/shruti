import type { Transcript } from "@lib/domain/transcript.js"
import type { UiTranscriptBlock } from "@ui/features/transcript/index.js"

/**
 * The single builder that converts a domain `Transcript` into the UI
 * mirror shape consumed by `@ui/features/transcript/TranscriptView.vue`.
 * Strips domain-only metadata (block references, etc.) that the UI
 * doesn't render today.
 *
 * If the mirror type gains fields later, update this function too —
 * the type-checker can't catch missing mappings.
 */
export function buildTranscriptViewData(
  transcript: Transcript | null
): readonly UiTranscriptBlock[] {
  if (!transcript) return []
  return transcript.blocks.map((block): UiTranscriptBlock => {
    switch (block.type) {
      case "sentence":
        return {
          type: "sentence",
          start: block.start,
          end: block.end,
          text: block.text,
          speaker: block.speaker,
        }
      case "verse:text":
        return {
          type: "verse:text",
          start: block.start,
          end: block.end,
          text: block.text,
        }
      case "verse:translation":
        return {
          type: "verse:translation",
          start: block.start,
          end: block.end,
          text: block.text,
        }
      case "paragraph":
      default:
        return { type: "paragraph", start: block.start, end: block.end }
    }
  })
}
