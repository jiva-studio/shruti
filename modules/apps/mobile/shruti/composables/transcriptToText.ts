import type { Transcript } from "@lib/domain/transcript.js"

/**
 * Flatten transcript blocks into readable plain text: one line per
 * sentence / verse, a blank line at paragraph boundaries.
 */
export function transcriptToText(transcript: Transcript): string {
  const out: string[] = []
  for (const block of transcript.blocks) {
    switch (block.type) {
      case "paragraph":
        if (out.length > 0 && out[out.length - 1] !== "") out.push("")
        break
      case "sentence":
      case "verse:translation": {
        const line = block.text.trim()
        if (line) out.push(line)
        break
      }
      case "verse:text": {
        const line = block.text.join(" ").trim()
        if (line) out.push(line)
        break
      }
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
