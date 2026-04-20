import type { Reference } from "@lib/domain/reference.js"
import type { Transcript } from "@lib/domain/transcript.js"
import type {
  UiTranscriptBlockRaw,
  UiTranscriptBlockView,
  UiTranscriptBlocksGroup,
  UiTranscriptLanguage,
} from "@ui/features/transcript/index.js"

/**
 * Default transcript-block reference formatter: "bg 10.5".
 * We don't have the sources dictionary in this layer — downstream UI
 * can replace/localise it if needed, but this keeps the mirror type
 * populated with a sensible string.
 */
function formatReference(ref: Reference): string {
  const tokens = ref.tokens.join(".")
  return tokens.length > 0 ? `${ref.sourceId} ${tokens}` : ref.sourceId
}

/**
 * Flattens one domain `Transcript` into UI mirror blocks, grouped by
 * paragraph. A new group starts whenever we hit a paragraph marker;
 * empty groups are dropped.
 */
export function buildTranscriptViewData(
  transcript: Transcript | null
): readonly UiTranscriptBlocksGroup[] {
  if (!transcript) return []

  const groups: UiTranscriptBlocksGroup[] = []
  let current: UiTranscriptBlockView[] = []
  let lastSpeaker: string | undefined = undefined

  for (const block of transcript.blocks) {
    if (block.type === "paragraph") {
      if (current.length > 0) groups.push({ blocks: current })
      current = []
      lastSpeaker = undefined
      continue
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
            reference: block.reference ? formatReference(block.reference) : undefined,
          }
        : block.type === "verse:text"
          ? {
              type: "verse:text",
              start: block.start,
              end: block.end,
              text: block.text,
              reference: block.reference ? formatReference(block.reference) : undefined,
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
      bookmarked: false,
      selected: false,
    })

    if (block.type === "sentence") lastSpeaker = block.speaker
  }

  if (current.length > 0) groups.push({ blocks: current })
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
