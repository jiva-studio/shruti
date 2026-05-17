import { marked } from "marked"

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

export type ActionKind = "create_playlist" | "save_note"

export type ChatToken =
  | { readonly kind: "text"; readonly html: string }
  | {
      readonly kind: "cite"
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      /** Snippet caption emitted by the LLM (3–6 words describing the
       *  fragment). Empty when the marker omitted it — the chip falls
       *  back to the lecture title in that case. */
      readonly caption: string
    }
  | { readonly kind: "card"; readonly trackId: string }
  | { readonly kind: "outline"; readonly trackId: string }
  | {
      readonly kind: "action"
      readonly actionKind: ActionKind
      readonly actionId: string
    }

/* -------------------------------------------------------------------------- */
/*                                  Regexes                                   */
/* -------------------------------------------------------------------------- */

// Permissive trackId character class: matches shruti ids which can
// include underscores, dashes, and dots (e.g. "BG_1972_01.05"). The
// optional `|caption` tail captures everything up to the closing `]`.
const CITE_RE = /\[cite:([A-Za-z0-9_.-]+)@(\d+)-(\d+)(?:\|([^\]\n]*))?\]/g
const CARD_RE = /\[card:([A-Za-z0-9_.-]+)\]/g
const OUTLINE_RE = /\[outline:([A-Za-z0-9_.-]+)\]/g
// Snake-case kinds throughout: marker, action-card payload, action enum
// — one wire format end-to-end. Regex stays permissive (matches `a-z0-9_`)
// so a malformed marker with a stray dash is still captured by the
// outer pattern and then rejected by `parseActionKind` below.
const ACTION_RE = /\[action:([a-z][a-z0-9_]*)\|id=([A-Za-z0-9_-]+)\]/g

interface MarkerHit {
  readonly start: number
  readonly end: number
  readonly token: ChatToken
}

/* -------------------------------------------------------------------------- */
/*                                  Parser                                    */
/* -------------------------------------------------------------------------- */

/**
 * Split an assistant message into renderable tokens. Inline markdown
 * inside text segments is run through `marked.parseInline` so the
 * caller can render via `v-html` without a heavy block-level parser
 * (assistant output is intentionally inline-style).
 *
 * The function is sync because `marked.parseInline` is sync in the
 * default configuration we use (no async extensions installed).
 */
export function parseChatMarkers(input: string): ChatToken[] {
  if (!input) return []

  const hits: MarkerHit[] = []
  for (const match of input.matchAll(CITE_RE)) {
    const [full, trackId, startStr, endStr, captionRaw] = match
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      token: {
        kind: "cite",
        trackId,
        startMs: Number(startStr) | 0,
        endMs: Number(endStr) | 0,
        caption: (captionRaw ?? "").trim(),
      },
    })
  }
  for (const match of input.matchAll(CARD_RE)) {
    const [full, trackId] = match
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      token: { kind: "card", trackId },
    })
  }
  for (const match of input.matchAll(OUTLINE_RE)) {
    const [full, trackId] = match
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      token: { kind: "outline", trackId },
    })
  }
  for (const match of input.matchAll(ACTION_RE)) {
    const [full, rawKind, actionId] = match
    const actionKind = parseActionKind(rawKind)
    if (!actionKind) continue
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      token: { kind: "action", actionKind, actionId },
    })
  }
  hits.sort((a, b) => a.start - b.start)

  const out: ChatToken[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start < cursor) continue // overlap — skip
    if (hit.start > cursor) {
      pushTextToken(out, input.slice(cursor, hit.start))
    }
    out.push(hit.token)
    cursor = hit.end
  }
  if (cursor < input.length) {
    pushTextToken(out, input.slice(cursor))
  }
  return collapseBlanksAroundCards(out)
}

/**
 * Cards render as block-level elements with their own vertical margin.
 * Any `<br>` / whitespace sitting on the boundary with a card stacks on
 * top of that built-in margin and produces an ugly empty gap. For each
 * text token: strip leading `<br>` runs when the previous token is a
 * card, strip trailing `<br>` runs when the next is a card, and drop
 * the token entirely if nothing readable remains.
 */
function collapseBlanksAroundCards(tokens: ChatToken[]): ChatToken[] {
  const LEAD = /^(?:\s|<br\s*\/?>)+/i
  const TRAIL = /(?:\s|<br\s*\/?>)+$/i
  const isBlank = (html: string) => /^(?:\s|<br\s*\/?>)*$/i.test(html)
  const blockLike = (k: ChatToken["kind"] | undefined) =>
    k === "card" || k === "outline" || k === "action"
  const out: ChatToken[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind !== "text") {
      out.push(tok)
      continue
    }
    let html = tok.html
    if (blockLike(tokens[i - 1]?.kind)) html = html.replace(LEAD, "")
    if (blockLike(tokens[i + 1]?.kind)) html = html.replace(TRAIL, "")
    if (isBlank(html)) continue
    out.push({ kind: "text", html })
  }
  return out
}

/** Strict whitelist — only the two known action kinds are accepted.
 *  Anything else (including legacy kebab `create-playlist`) returns null
 *  so the marker is silently dropped from the parsed token stream. */
function parseActionKind(raw: string): ActionKind | null {
  if (raw === "create_playlist" || raw === "save_note") return raw
  return null
}

function pushTextToken(out: ChatToken[], raw: string): void {
  if (!raw) return
  // Markdown list bullets are a BLOCK-level feature and `marked.parseInline`
  // doesn't expand them — without this the LLM's "* item" prints literally,
  // and the `*` looks like a multiplication glyph. Substitute a real bullet
  // glyph BEFORE inline-parsing so it survives as plain text and only the
  // inline emphasis around it (`**X**` → `<strong>X</strong>`) is parsed.
  const withBullets = raw.replace(/^[ \t]*[*\-+][ \t]+/gm, "• ")
  let html: string
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
    html = inlineHtml
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>")
      // Collapse runs of intra-line spaces — the LLM often emits double
      // spaces after periods or around markers and they read as a
      // visual gap in rendered prose.
      .replace(/ {2,}/g, " ")
  } catch {
    html = escapeHtml(withBullets)
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>")
      .replace(/ {2,}/g, " ")
  }
  out.push({ kind: "text", html })
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
