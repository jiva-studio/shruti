const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Escape the five HTML-significant characters so a string is safe to
 *  drop into `v-html` output. Shared by the chat marker renderer and the
 *  notes match-highlighter. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!)
}
