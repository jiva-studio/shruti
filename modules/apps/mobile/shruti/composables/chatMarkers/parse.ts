import { inlineMd, pushTextToken } from "./renderHtml.js"

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
      /** Chapter-location widget — "where in scripture is this?". Rendered
       *  by `ChapterCard.vue`. Names a region `(sourceId, regionToken)`;
       *  the canto/chapter titles ride the `chapter` SSE payload and are
       *  read from the message's `chapters` map. `caption` is the region label
       *  (canto heading / book name) carried inline on the marker. */
      readonly kind: "chapter"
      readonly sourceId: string
      readonly regionToken: string
      readonly caption: string
    }
  | {
      /** Media result widget — a video/audio file with a transcript.
       *  Rendered by `MediaCard.vue`. The `mediaId` is the join key into
       *  `message.media[mediaId]`, where the `media` SSE action stashed
       *  the payload (url / type / title / text). `caption` is the
       *  marker-inline label (currently unused by the card, which renders
       *  the server-built `title` instead — kept for parity with the
       *  other widget markers and markdown export). */
      readonly kind: "media"
      readonly mediaId: string
      readonly caption: string
    }
  | {
      /** Commentary / prose-chapter / letter citation rendered as a CARD
       *  (text + author + reference), the audio-citation shape. `ref` is the
       *  integer join key into the message's `commentaries` map, where the
       *  `commentary` SSE action stashed the quote. Emitted only for
       *  card-capable clients; legacy turns inline a `quote` token instead. */
      readonly kind: "commentary"
      readonly ref: number
    }
  | {
      /** Library document citation — commentary, prose chapter, or
       *  letter — rendered as a styled blockquote with an optional
       *  italic attribution line. Legacy (non-card) form; still produced
       *  for already-persisted history and non-card clients. */
      readonly kind: "quote"
      readonly bodyHtml: string
      readonly attributionHtml?: string
    }

/* -------------------------------------------------------------------------- */
/*                                  Regexes                                   */
/* -------------------------------------------------------------------------- */

// Permissive trackId character class: matches shruti ids which can
// include underscores, dashes, and dots (e.g. "BG_1972_01.05"). The
// optional `|caption` tail captures everything up to the closing `]`.
export const CITE_RE = /\[cite:([A-Za-z0-9_.-]+)@(\d+)-(\d+)(?:\|([^\]\n]*))?\]/g
export const CARD_RE = /\[card:([A-Za-z0-9_.-]+)\]/g
export const OUTLINE_RE = /\[outline:([A-Za-z0-9_.-]+)\]/g
// Library verse widget marker. source_id matches `source_<base62-12>` plus a
// permissive class for safety; tokens are digit groups separated by `.` or `,`
// (combined verses like "1.2.28,1.2.29").
export const VERSE_RE = /\[verse:([A-Za-z0-9_]+)\/([0-9.,-]+)(?:\|([^\]\n]*))?\]/g
// Chapter-location widget marker: a source_id and a region token, optional
// `|label` carrying the canto heading / book name. The region token is an
// OPAQUE join key (marker ↔ the `chapter` payload on the message's `chapters`
// map) — the client must NOT assume its shape. The server owns source structure: it's a canto ("12"),
// a chapter ("9"), EMPTY for book-level regions (2-level books like BG/CC), or
// anything a future book layout needs. Match any run up to `|`/`]` (incl.
// empty) so new source shapes never require a client regex change.
export const CHAPTER_RE = /\[chapter:([A-Za-z0-9_]+)\/([^|\]\n]*)(?:\|([^\]\n]*))?\]/g
// Media result widget marker. The id is the join key into the `media` SSE
// action payload (mirrors `[verse:.../...]`, but the address is a single
// opaque id rather than source/tokens). Permissive id class so future id
// shapes (uuid, base62, dotted) never need a regex change; optional
// `|caption` tail captures everything up to the closing `]`.
export const MEDIA_RE = /\[media:([A-Za-z0-9_.-]+)(?:\|([^\]\n]*))?\]/g
// Commentary citation marker. Just the integer ref — the quote text,
// author, and reference ride the `commentary` SSE action payload (the
// audio-citation pattern), keyed by this ref in the message's
// `commentaries` map.
export const COMMENTARY_RE = /\[commentary:(\d+)\]/g
// Markdown blockquote run: one or more consecutive lines starting with `>`.
// Match begins after a line boundary (start-of-string or `\n`). The capture
// group keeps the raw lines (each still prefixed by `>`) so the parser can
// peel the leading `>` and detect an optional trailing italic attribution.
export const QUOTE_RE = /(?:^|\n)((?:[ \t]*>[^\n]*(?:\n|$))+)/g
// Snake-case kinds throughout: marker, action-card payload, action enum
// — one wire format end-to-end. Regex stays permissive (matches `a-z0-9_`)
// so a malformed marker with a stray dash is still captured by the
// outer pattern and then rejected by `parseActionKind` below.
export const ACTION_RE = /\[action:([a-z][a-z0-9_]*)\|id=([A-Za-z0-9_-]+)\]/g
// Follow-up chips are TEXT markers (no id, no payload). `text` is any
// run of non-`]`/`|`/newline chars — strict on purpose so the LLM
// cannot accidentally swallow neighbouring prose by forgetting the
// closing bracket. Empty text is rejected (`+` not `*`). Cap on chip
// count is applied in `extractFollowups`, not in the regex.
export const FOLLOWUP_RE = /\[followup:([^\]|\n]+)\]/g
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
  // Most markers map one regex match → one fixed-length hit. `collect`
  // captures that shape; the `make` callback returns null to skip a
  // match (e.g. an unknown action kind). The blockquote pass below is
  // bespoke because its range excludes a leading newline.
  const collect = (
    re: RegExp,
    make: (m: RegExpMatchArray, start: number) => MarkerHit | null
  ): void => {
    for (const match of input.matchAll(re)) {
      const hit = make(match, match.index ?? 0)
      if (hit) hits.push(hit)
    }
  }

  collect(CITE_RE, (m, start) => {
    const [full, trackId, startStr, endStr, captionRaw] = m
    return {
      start,
      end: start + full.length,
      token: {
        kind: "cite",
        trackId,
        startMs: Number(startStr) | 0,
        endMs: Number(endStr) | 0,
        caption: (captionRaw ?? "").trim(),
      },
    }
  })
  // Single-card token. The post-processing pass below groups adjacent
  // cards into a `cards` list before returning.
  collect(CARD_RE, (m, start) => {
    const [full, trackId] = m
    return { start, end: start + full.length, token: { kind: "cards", trackIds: [trackId] } }
  })
  collect(OUTLINE_RE, (m, start) => {
    const [full, trackId] = m
    return { start, end: start + full.length, token: { kind: "outline", trackId } }
  })
  collect(ACTION_RE, (m, start) => {
    const [full, rawKind, actionId] = m
    const actionKind = parseActionKind(rawKind)
    if (!actionKind) return null
    return { start, end: start + full.length, token: { kind: "action", actionKind, actionId } }
  })
  collect(VERSE_RE, (m, start) => {
    const [full, sourceId, tokens, captionRaw] = m
    return {
      start,
      end: start + full.length,
      token: { kind: "verse", sourceId, tokens, caption: (captionRaw ?? "").trim() },
    }
  })
  collect(CHAPTER_RE, (m, start) => {
    const [full, sourceId, regionToken, captionRaw] = m
    return {
      start,
      end: start + full.length,
      token: { kind: "chapter", sourceId, regionToken, caption: (captionRaw ?? "").trim() },
    }
  })
  collect(MEDIA_RE, (m, start) => {
    const [full, mediaId, captionRaw] = m
    return {
      start,
      end: start + full.length,
      token: { kind: "media", mediaId, caption: (captionRaw ?? "").trim() },
    }
  })
  collect(COMMENTARY_RE, (m, start) => {
    const [full, refStr] = m
    return {
      start,
      end: start + full.length,
      token: { kind: "commentary", ref: Number(refStr) | 0 },
    }
  })
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
    hits.push({ start, end, token: { kind: "quote", bodyHtml, attributionHtml } })
  }
  // Followup markers are stripped from the prose (chips render outside
  // the bubble), so we record their spans in `hits` to drop them from
  // the text segments — but never push a renderable token for them.
  collect(FOLLOWUP_RE, (m, start) => ({
    start,
    end: start + m[0].length,
    // Sentinel token kind: never emitted into the output stream.
    token: { kind: "text", html: "" },
    drop: true,
  }))
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
  return trimTrailingBreaks(groupAdjacentCards(collapseBlanksAroundCards(out)))
}

/**
 * Strip trailing `<br>` runs (plus any pure whitespace) from the last
 * text token, dropping the token entirely if nothing readable remains.
 *
 * The LLM frequently ends a message with a paragraph break (`\n\n`),
 * which `pushTextToken` translates to a `<br><br>`. Without this pass
 * the bubble carries that phantom blank line at its bottom edge,
 * which now reads as an awkward gap between the prose and the
 * `ChatMessageActions` row sitting underneath. Block-like tokens
 * (cards / outline / quote / verse) don't have this problem and stay
 * untouched.
 */
function trimTrailingBreaks(tokens: ChatToken[]): ChatToken[] {
  if (tokens.length === 0) return tokens
  const last = tokens[tokens.length - 1]
  if (last.kind !== "text") return tokens
  const stripped = last.html.replace(/(?:\s|<br\s*\/?>)+$/i, "")
  if (stripped === last.html) return tokens
  const next = [...tokens]
  if (stripped.length === 0) {
    next.pop()
  } else {
    next[next.length - 1] = { kind: "text", html: stripped }
  }
  return next
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
    k === "cards" ||
    k === "outline" ||
    k === "action" ||
    k === "quote" ||
    k === "commentary" ||
    k === "verse" ||
    k === "chapter" ||
    k === "media" ||
    // `cite` now renders as a block quote-card (CitationCard) when its
    // transcript text is present; collapse surrounding <br>/whitespace
    // like the other block tokens. (In chip-fallback mode it's inline —
    // same dual nature as `verse`, which is already listed here.)
    k === "cite"
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
