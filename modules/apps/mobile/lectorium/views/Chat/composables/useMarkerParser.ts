import { marked } from "marked"

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

export type ActionKind =
  | "share_pdf"
  | "enable_daily_reminder"
  | "configure_smart_library"
  | "upgrade_to_pro"
  | "queue_next_track"

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
  /** A list of one or more track cards. The parser groups consecutive
   *  `[card:X]` markers (no text token between them) into a single
   *  `cards` token; isolated cards still arrive as length-1 lists.
   *  Renders via `TrackList` — single track = one lecture card,
   *  multiple tracks = card stack with an "add to playlist" button. */
  | { readonly kind: "cards"; readonly trackIds: readonly string[] }
  | { readonly kind: "outline"; readonly trackId: string }
  | {
      readonly kind: "action"
      readonly actionKind: ActionKind
      readonly actionId: string
    }
  | {
      /** Library verse widget (sanskrit / IAST / translation). Rendered
       *  by `VerseCard.vue`. Address is `(sourceId, tokens)`. */
      readonly kind: "verse"
      readonly sourceId: string
      readonly tokens: string
      readonly caption: string
    }
  | {
      /** Library document citation — commentary, prose chapter, or
       *  letter — rendered as a styled blockquote with an optional
       *  italic attribution line. */
      readonly kind: "quote"
      readonly bodyHtml: string
      readonly attributionHtml?: string
    }

/* -------------------------------------------------------------------------- */
/*                                  Regexes                                   */
/* -------------------------------------------------------------------------- */

// Permissive trackId character class: matches lectorium ids which can
// include underscores, dashes, and dots (e.g. "BG_1972_01.05"). The
// optional `|caption` tail captures everything up to the closing `]`.
const CITE_RE = /\[cite:([A-Za-z0-9_.-]+)@(\d+)-(\d+)(?:\|([^\]\n]*))?\]/g
const CARD_RE = /\[card:([A-Za-z0-9_.-]+)\]/g
const OUTLINE_RE = /\[outline:([A-Za-z0-9_.-]+)\]/g
// Library verse widget marker. source_id matches `source_<base62-12>` plus a
// permissive class for safety; tokens are digit groups separated by `.` or `,`
// (combined verses like "1.2.28,1.2.29").
const VERSE_RE = /\[verse:([A-Za-z0-9_]+)\/([0-9.,-]+)(?:\|([^\]\n]*))?\]/g
// Markdown blockquote run: one or more consecutive lines starting with `>`.
// Match begins after a line boundary (start-of-string or `\n`). The capture
// group keeps the raw lines (each still prefixed by `>`) so the parser can
// peel the leading `>` and detect an optional trailing italic attribution.
const QUOTE_RE = /(?:^|\n)((?:[ \t]*>[^\n]*(?:\n|$))+)/g
// Snake-case kinds throughout: marker, action-card payload, action enum
// — one wire format end-to-end. Regex stays permissive (matches `a-z0-9_`)
// so a malformed marker with a stray dash is still captured by the
// outer pattern and then rejected by `parseActionKind` below.
const ACTION_RE = /\[action:([a-z][a-z0-9_]*)\|id=([A-Za-z0-9_-]+)\]/g
// Follow-up chips are TEXT markers (no id, no payload). `text` is any
// run of non-`]`/`|`/newline chars — strict on purpose so the LLM
// cannot accidentally swallow neighbouring prose by forgetting the
// closing bracket. Empty text is rejected (`+` not `*`). Cap on chip
// count is applied in `extractFollowups`, not in the regex.
const FOLLOWUP_RE = /\[followup:([^\]|\n]+)\]/g
/** Max chips surfaced under one bubble. The prompt asks the LLM for
 *  ≤3, but the parser enforces it so a misbehaving turn never floods
 *  the UI. */
const FOLLOWUP_MAX = 3

interface MarkerHit {
  readonly start: number
  readonly end: number
  readonly token: ChatToken
  /** When true, the hit's range is excised from the prose but no
   *  token is pushed (used for `[followup:..]` which renders outside
   *  the bubble). */
  readonly drop?: boolean
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
      // Single-card token. The post-processing pass below groups
      // adjacent cards into a `cards` list before returning.
      token: { kind: "cards", trackIds: [trackId] },
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
  for (const match of input.matchAll(VERSE_RE)) {
    const [full, sourceId, tokens, captionRaw] = match
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      token: {
        kind: "verse",
        sourceId,
        tokens,
        caption: (captionRaw ?? "").trim(),
      },
    })
  }
  // Markdown blockquotes — group consecutive `> ...` lines into one
  // `quote` token. The capturing group starts AFTER the leading newline
  // (or at the string start), so the hit's range covers the run minus
  // that boundary char — we leave the boundary newline in the text
  // segment so paragraph breaks render correctly above the quote.
  for (const match of input.matchAll(QUOTE_RE)) {
    const lead = match[0].startsWith("\n") ? 1 : 0
    const block = match[1]
    if (!block) continue
    const start = (match.index ?? 0) + lead
    const end = start + block.length
    const { bodyHtml, attributionHtml } = parseQuoteBlock(block)
    if (!bodyHtml && !attributionHtml) continue
    hits.push({
      start,
      end,
      token: { kind: "quote", bodyHtml, attributionHtml },
    })
  }
  // Followup markers are stripped from the prose (chips render outside
  // the bubble), so we record their spans in `hits` to drop them from
  // the text segments — but never push a renderable token for them.
  for (const match of input.matchAll(FOLLOWUP_RE)) {
    const [full] = match
    const start = match.index ?? 0
    hits.push({
      start,
      end: start + full.length,
      // Sentinel token kind: never emitted into the output stream.
      token: { kind: "text", html: "" },
      drop: true,
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
    if (!hit.drop) out.push(hit.token)
    cursor = hit.end
  }
  if (cursor < input.length) {
    pushTextToken(out, input.slice(cursor))
  }
  return groupAdjacentCards(collapseBlanksAroundCards(out))
}

/**
 * Fold consecutive `cards` tokens (each emitted with a single trackId
 * by the parser) into one `cards` token carrying the full list. The
 * synth emits stacked `[^N]` markers when answering list / playlist
 * queries — the client renders the merged token as either a single
 * lecture card or a card stack with an "add to playlist" button.
 *
 * Adjacent means "no other token between them" — a text token (even
 * a `<br>`) breaks the run; the blank-collapse pass above removes the
 * blank-only text tokens so cards separated only by whitespace get
 * grouped.
 */
function groupAdjacentCards(tokens: ChatToken[]): ChatToken[] {
  const out: ChatToken[] = []
  let pending: string[] | null = null
  const flush = (): void => {
    if (pending && pending.length > 0) {
      out.push({ kind: "cards", trackIds: pending })
    }
    pending = null
  }
  for (const tok of tokens) {
    if (tok.kind === "cards") {
      pending ??= []
      pending.push(...tok.trackIds)
      continue
    }
    flush()
    out.push(tok)
  }
  flush()
  return out
}

/**
 * Extract `[followup:<text>]` chips from raw assistant content.
 * Strict parser (no regex fallback): malformed markers (`]` inside the
 * text, embedded `|`, empty text) are not recognised and leak into
 * prose — fixing them is the prompt's responsibility, never this
 * function's. Trims each chip text and caps at FOLLOWUP_MAX entries.
 *
 * Returns an empty array when `input` is empty or contains no valid
 * markers. The order matches the message: first marker = first chip.
 */
export function extractFollowups(input: string): string[] {
  if (!input) return []
  const out: string[] = []
  for (const match of input.matchAll(FOLLOWUP_RE)) {
    if (out.length >= FOLLOWUP_MAX) break
    const text = (match[1] ?? "").trim()
    if (text.length === 0) continue
    out.push(text)
  }
  return out
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
    k === "cards" || k === "outline" || k === "action" || k === "quote" || k === "verse"
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

/** Markdown blockquote block → bodyHtml + optional attributionHtml.
 *  Strip each line's leading `>` plus one optional space; if the last
 *  remaining line is wholly wrapped in `*…*` or `_…_`, peel it off as
 *  the italic attribution. Body lines run through `marked.parseInline`
 *  for inline emphasis/bold. */
function parseQuoteBlock(raw: string): { bodyHtml: string; attributionHtml?: string } {
  const lines = raw.split("\n").map((l) => l.replace(/^[ \t]*>[ \t]?/, ""))
  // Trim trailing blank line that QUOTE_RE may have eaten.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  if (lines.length === 0) return { bodyHtml: "" }

  let attributionHtml: string | undefined
  const last = lines[lines.length - 1].trim()
  const italicMatch = last.match(/^(?:\*([^*]+)\*|_([^_]+)_)$/)
  if (italicMatch && lines.length > 1) {
    const inner = italicMatch[1] ?? italicMatch[2] ?? ""
    attributionHtml = inlineMd(inner)
    lines.pop()
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  }
  const bodyRaw = lines.join("\n").trim()
  const bodyHtml = bodyRaw ? inlineMd(bodyRaw).replace(/\n/g, "<br>") : ""
  return { bodyHtml, attributionHtml }
}

function inlineMd(raw: string): string {
  try {
    const parsed = marked.parseInline(raw, { async: false }) as unknown
    return typeof parsed === "string" ? parsed : escapeHtml(raw)
  } catch {
    return escapeHtml(raw)
  }
}

/** Strict whitelist — only known action kinds are accepted. Anything
 *  else (including legacy kebab `create-playlist`) returns null so the
 *  marker is silently dropped from the parsed token stream. */
function parseActionKind(raw: string): ActionKind | null {
  if (
    raw === "share_pdf" ||
    raw === "enable_daily_reminder" ||
    raw === "configure_smart_library" ||
    raw === "upgrade_to_pro" ||
    raw === "queue_next_track"
  ) {
    return raw
  }
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
