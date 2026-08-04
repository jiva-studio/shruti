import { marked } from "marked"
import { escapeHtml } from "../utils/escapeHtml.js"
import type { ChatToken } from "./parse.js"

/* -------------------------------------------------------------------------- */
/*                       Markdown → HTML (inline rendering)                   */
/* -------------------------------------------------------------------------- */

/**
 * Inline-markdown → HTML helpers shared by the marker parser. The chat
 * bubble renders the resulting `text` tokens via `v-html`, so all output
 * here is already escaped/rendered. Depends on `marked`, which is why
 * this whole concern lives in the composition-root layer (not @lib).
 */

export function inlineMd(raw: string): string {
  try {
    const parsed = marked.parseInline(raw, { async: false }) as unknown
    return typeof parsed === "string" ? parsed : escapeHtml(raw)
  } catch {
    return escapeHtml(raw)
  }
}

/**
 * Render a run of prose (NO block headers) the inline-only way: bullets →
 * glyph, `marked.parseInline` for emphasis / bold / code, then our own
 * paragraph (`<br><br>`) and soft-break (`<br>`) rules. Extracted from
 * `pushTextToken` so the header-aware walk below can reuse it verbatim for
 * every non-heading run.
 */
function renderInlineRun(raw: string): string {
  // Markdown list bullets are a BLOCK-level feature and `marked.parseInline`
  // doesn't expand them — without this the LLM's "* item" prints literally,
  // and the `*` looks like a multiplication glyph. Substitute a real bullet
  // glyph BEFORE inline-parsing so it survives as plain text and only the
  // inline emphasis around it (`**X**` → `<strong>X</strong>`) is parsed.
  const withBullets = raw.replace(/^[ \t]*[*\-+][ \t]+/gm, "• ")
  try {
    // First run marked.parseInline for emphasis / bold / code spans, then
    // map our own paragraph and line-break rules:
    //   blank line  → paragraph break (<br><br>) — visually a paragraph
    //   single \n   → soft break (<br>)         — keeps "1. ... 2. ..."
    //                                              groups readable
    // This is cheaper than spinning up the full block parser and avoids
    // marked wrapping snippets in <p>…</p> tags that would break our
    // inline-mixed token stream.
    const inline = marked.parseInline(withBullets, { async: false }) as unknown
    const inlineHtml = typeof inline === "string" ? inline : escapeHtml(withBullets)
    return (
      inlineHtml
        .replace(/\n{2,}/g, "<br><br>")
        .replace(/\n/g, "<br>")
        // Collapse runs of intra-line spaces — the LLM often emits double
        // spaces after periods or around markers and they read as a
        // visual gap in rendered prose.
        .replace(/ {2,}/g, " ")
    )
  } catch {
    return escapeHtml(withBullets)
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>")
      .replace(/ {2,}/g, " ")
  }
}

/** True only for ATX headings (`## Label`). `marked` also emits
 *  `type === "heading"` for SETEXT form (a prose line underlined by `---`),
 *  which would wrongly swallow that prose line + drop the `---`. Gate on the
 *  leading `#` so setext headings fall through to the inline pipeline and
 *  render literally, exactly as before. */
function isAtxHeading(tok: { type?: string; raw?: string }): boolean {
  return tok.type === "heading" && (tok.raw ?? "").trimStart().startsWith("#")
}

export function pushTextToken(out: ChatToken[], raw: string): void {
  if (!raw) return
  // Block-level ATX headers (`## Label`) are the one piece of block markdown
  // we render specially — the synthesizer emits them above each thesis, and
  // the bubble draws them as a centered <h2> flanked by CSS gradient rules.
  // `renderInlineRun` (marked.parseInline) silently drops block headers, so
  // lex the segment into blocks: pull ATX heading tokens out as <h2>, and
  // re-feed every other run through the inline pipeline verbatim via its raw
  // source so prose / lists / spacing stay byte-identical to before.
  let tokens: ReturnType<typeof marked.lexer> | null
  try {
    tokens = marked.lexer(raw)
  } catch {
    tokens = null
  }
  // No header present (or lexer unavailable) → the original fast path on the
  // untouched source. Keeps the common, header-free message zero-risk.
  if (!tokens || !tokens.some((t) => isAtxHeading(t))) {
    const html = renderInlineRun(raw)
    if (html) out.push({ kind: "text", html })
    return
  }

  let html = ""
  let buffer = ""
  // Does the current buffered run begin right after an <h2>? The blank line
  // the LLM leaves around a header would otherwise render as a leading
  // <br><br> gap stacked on top of the <h2>'s own margin.
  let bufferAfterHeading = false
  let lastWasHeading = false
  const flushBuffer = (): void => {
    if (!buffer) return
    let run = renderInlineRun(buffer)
    if (bufferAfterHeading) run = run.replace(/^(?:<br\s*\/?>\s*)+/i, "")
    html += run
    buffer = ""
    bufferAfterHeading = false
  }
  for (const tok of tokens) {
    if (isAtxHeading(tok)) {
      flushBuffer()
      // Drop a trailing <br> gap before the header for the same reason.
      html = html.replace(/(?:<br\s*\/?>\s*)+$/i, "")
      const text = (tok as { text: string }).text
      const inner = marked.parseInline(text, { async: false }) as unknown
      const innerHtml = typeof inner === "string" ? inner : escapeHtml(text)
      html += `<h2 class="chat-header">${innerHtml}</h2>`
      lastWasHeading = true
    } else {
      if (!buffer) bufferAfterHeading = lastWasHeading
      buffer += tok.raw
      lastWasHeading = false
    }
  }
  flushBuffer()
  if (html) out.push({ kind: "text", html })
}

/* -------------------------------------------------------------------------- */
/*               Excerpt rendering (citation / commentary cards)              */
/* -------------------------------------------------------------------------- */

/** A śloka quoted inside a purport is stored one line per paragraph (CRLF +
 *  blank lines between the lines of one stanza). A quote is joined from whole
 *  sentences, so a blank line inside one is always that stanza formatting, not
 *  a paragraph break — collapse the run so the lines read as a stanza. Mirrors
 *  what `VerseCard` does for the verse's own sanskrit / transliteration. */
export function normalizeQuoteBreaks(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n[\s]*/g, "\n")
}

/** Markdown blockquote run: consecutive lines starting with `>`. Mirrors
 *  `QUOTE_RE` in parse.ts but kept local so this module doesn't import from
 *  parse.ts — which already imports from here (avoids an import cycle). */
const EXCERPT_QUOTE_RE = /(?:^|\n)((?:[ \t]*>[^\n]*(?:\n|$))+)/g

/** A `>` blockquote block (e.g. a śloka quoted inside a purport) → an italic
 *  `.excerpt-quote` block: each line's leading `>` is stripped and the body
 *  sits on its own line. A whole-block `*…*` / `_…_` italic wrapper (the
 *  transliteration emphasis) is peeled so no stray asterisks survive — the
 *  CSS already italicises the block. */
function renderQuoteBlock(block: string): string {
  const lines = block.split("\n").map((l) => l.replace(/^[ \t]*>[ \t]?/, ""))
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  if (lines.length === 0) return ""
  let bodyRaw = lines.join("\n").trim()
  const wrap = bodyRaw.match(/^([*_])([\s\S]+)\1$/)
  if (wrap && !wrap[2].includes(wrap[1])) bodyRaw = wrap[2]
  const bodyHtml = bodyRaw ? inlineMd(bodyRaw).replace(/\n/g, "<br>") : ""
  return `<blockquote class="excerpt-quote">${bodyHtml}</blockquote>`
}

/**
 * Render an excerpt body (citation transcript snippet / commentary purport)
 * to HTML for `ExcerptCard` → `HighlightText` (`v-html`). Uses the same
 * inline pipeline as the chat bubble (`*`/`**`/code/links, bullets → •) and
 * additionally lifts markdown blockquotes (`> …`) into styled
 * `.excerpt-quote` blocks, so a quoted śloka renders as an italic quote on
 * its own line instead of printing the literal `>`.
 */
export function renderExcerptHtml(input: string): string {
  if (!input) return ""
  const raw = normalizeQuoteBreaks(input)
  let out = ""
  let cursor = 0
  for (const m of raw.matchAll(EXCERPT_QUOTE_RE)) {
    const block = m[1]
    const blockStart = (m.index ?? 0) + (m[0].length - block.length)
    if (blockStart > cursor) {
      const prose = raw.slice(cursor, blockStart).replace(/\n+$/, "")
      if (prose) out += renderInlineRun(prose)
    }
    out += renderQuoteBlock(block)
    cursor = (m.index ?? 0) + m[0].length
  }
  if (cursor < raw.length) {
    const prose = raw.slice(cursor).replace(/^\n+/, "")
    if (prose) out += renderInlineRun(prose)
  }
  return out
}
