import { marked } from "marked"

/**
 * Render inline markdown (emphasis, bold) from transcript text to HTML for
 * v-html. Verified human transcripts carry `*italic*` (Sanskrit terms, song
 * titles) and `**bold**`; `marked` HTML-escapes the raw text first, so this is
 * safe to feed into v-html. Block-level constructs are intentionally not
 * supported — transcript text is a single inline run.
 */
export function renderInlineMarkdown(text: string): string {
  return marked.parseInline(text, { async: false }) as string
}
