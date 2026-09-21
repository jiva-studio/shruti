import { escapeHtml } from "@lib/chat/utils/escapeHtml.js"

/** Below this, a query paints half the page yellow rather than marking a match. */
export const MATCH_HIGHLIGHT_MIN_LENGTH = 4

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * `html` with every case-insensitive occurrence of `query` wrapped in
 * `<mark>`, expanded to the whole word around the match.
 *
 * `html` is already rendered markdown, so it must NOT be re-escaped: the
 * `<mark>` goes into the text runs only, never inside a generated tag, which
 * would corrupt the markup. The query is escaped so it matches the escaped
 * text and cannot break the `v-html` render.
 */
export function highlightHtml(html: string, query: string): string {
  const needle = escapeHtml(query)
  if (needle.length === 0) return html
  // \p{L} keeps Cyrillic/Latin/Greek letters together with digits and `_`.
  const pattern = new RegExp(`[\\p{L}\\p{N}_]*${escapeRegExp(needle)}[\\p{L}\\p{N}_]*`, "giu")
  // Capturing split → odd segments are tags, even segments are visible text.
  return html
    .split(/(<[^>]+>)/)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(pattern, (match) => `<mark>${match}</mark>`)))
    .join("")
}
