import { Marked } from "marked"

/**
 * Markdown → HTML for `v-html`, for every UI that renders authored text:
 * the transcript, the help pages, the chat bubble's cards.
 *
 * `marked` escapes the text it renders but passes raw HTML through verbatim,
 * so a tag in the source reaches the DOM as markup. The `html` renderer below
 * takes those tokens and writes them as their own text instead. Escaping the
 * source before parsing would do it too, but `>` opens a blockquote and `&`
 * is re-escaped inside a code span, so that costs both.
 *
 * A link is the other place a URL reaches an attribute, so its scheme is
 * checked: everything the app legitimately links to is http(s), mailto, an
 * anchor or a root-relative path, and the rest renders as the link's text.
 */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/)/i

const engine = new Marked({
  renderer: {
    html(token) {
      return escapeHtml(token.raw)
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens)
      if (!SAFE_HREF.test(token.href.trim())) return text
      return `<a href="${escapeHtml(token.href)}">${text}</a>`
    },
  },
})

/** Emphasis, code spans and links. Block constructs are not rendered. */
export function inlineMarkdownToHtml(src: string): string {
  try {
    const out = engine.parseInline(src, { async: false }) as unknown
    return typeof out === "string" ? out : escapeHtml(src)
  } catch {
    return escapeHtml(src)
  }
}

/** The full block grammar — headings, lists, blockquotes, tables. */
export function blockMarkdownToHtml(src: string): string {
  try {
    const out = engine.parse(src, { async: false, gfm: true, breaks: false }) as unknown
    return typeof out === "string" ? out : escapeHtml(src)
  } catch {
    return escapeHtml(src)
  }
}
