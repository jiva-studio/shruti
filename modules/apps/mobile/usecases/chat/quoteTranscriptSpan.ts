import type { TranscriptBlock } from "@lib/domain/transcript.js"

/**
 * The words the speaker said in `[startMs; endMs]` — every sentence block
 * overlapping the closed interval, joined. Non-sentence blocks carry no
 * quotable text and are passed over.
 */
export function quoteTranscriptSpan(
  blocks: readonly TranscriptBlock[],
  startMs: number,
  endMs: number
): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== "sentence") continue
    if (block.end < startMs || block.start > endMs) continue
    const text = block.text.trim()
    if (text) parts.push(text)
  }
  return parts.join(" ")
}
