import { inlineMarkdownToHtml } from "../markdown/markdown.js"

/**
 * Render inline markdown (emphasis, bold) from transcript text to HTML for
 * v-html. Verified human transcripts carry `*italic*` (Sanskrit terms, song
 * titles) and `**bold**`. Block-level constructs are intentionally not
 * supported — transcript text is a single inline run.
 */
export function renderInlineMarkdown(text: string): string {
  return inlineMarkdownToHtml(text)
}
