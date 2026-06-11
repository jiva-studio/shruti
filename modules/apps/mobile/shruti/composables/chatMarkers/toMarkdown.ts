import {
  ACTION_RE,
  CARD_RE,
  CHAPTER_RE,
  CITE_RE,
  COMMENTARY_RE,
  FOLLOWUP_RE,
  MEDIA_RE,
  OUTLINE_RE,
  VERSE_RE,
} from "./parse.js"

/* -------------------------------------------------------------------------- */
/*                  Plain-Markdown export (copy + share)                      */
/* -------------------------------------------------------------------------- */

/**
 * Verse body lookup callback (matches `useVerseBodyStore().get`). Kept
 * as an injected dependency so `messageToMarkdown` stays pure /
 * pinia-free and can be unit-tested with synthetic verse data.
 */
export interface VerseBodyLike {
  readonly addrLabel: string
  readonly sanskrit: string
  readonly transliteration: string
  readonly translation: { readonly [lang: string]: string }
}
export type VerseLookup = (sourceId: string, tokens: string) => VerseBodyLike | null

/**
 * Audio-citation body lookup — the cite analog of `VerseBodyLike`. `text`
 * is the transcript snippet (cached in `useCiteTranscriptStore`); the
 * optional attribution fields mirror what `CitationCard.vue` shows,
 * resolved client-side and already localized to the UI language. A null
 * return (no transcript cached) makes the cite strip out, exactly as it
 * did before this expansion existed.
 */
export interface CiteBodyLike {
  readonly text: string
  readonly trackTitle?: string
  readonly authorName?: string
  readonly reference?: string
  readonly trackDate?: string
}
export type CiteLookup = (trackId: string, startMs: number, endMs: number) => CiteBodyLike | null

/**
 * Commentary body lookup — the commentary analog of `CiteBodyLike`,
 * matching `useCommentaryBodyStore().get`. `text` is the cited quote;
 * `authorName` + `addrLabel` form the attribution. A null return (no
 * payload cached) strips the marker, same as a cite cache miss.
 */
export interface CommentaryBodyLike {
  readonly text: string
  readonly authorName: string
  readonly addrLabel: string
}
export type CommentaryLookup = (ref: number) => CommentaryBodyLike | null

export interface MessageToMarkdownOptions {
  /** UI language — picks `translation[lang]` for inline verses; falls
   *  back to English when the requested language is missing. */
  readonly lang: "ru" | "en"
  /** Lookup against the verse-body cache. Pass `() => null` if the
   *  caller doesn't have access (verses then drop out, same as widgets). */
  readonly verseLookup: VerseLookup
  /** Lookup against the cite-transcript cache (plus resolved track meta).
   *  Pass `() => null` to reproduce the legacy behavior where audio
   *  citations are stripped entirely. */
  readonly citeLookup: CiteLookup
  /** Lookup against the commentary-body cache. Pass `() => null` to strip
   *  `[commentary:N]` markers (legacy clients embed the quote as a `>`
   *  blockquote in the prose, so they need no lookup). */
  readonly commentaryLookup?: CommentaryLookup
}

/**
 * Convert an assistant message's raw content into a clean Markdown
 * string suitable for clipboard / share-sheet handoff. The function is
 * intentionally lossy: widget markers and audio citations are stripped
 * (the user can't usefully paste an inline track-card or audio chip
 * into another app), while prose, markdown blockquotes (library
 * document citations) and verse bodies are preserved.
 *
 *  Stripped: `[card:...]`, `[outline:...]`, `[action:...|id=...]`,
 *            `[followup:...]`
 *  Expanded: `[verse:sourceId/tokens|caption]` → addrLabel + sanskrit +
 *            transliteration + translation[lang]. Body is pulled from
 *            `verseLookup`; markers without a cached body are dropped.
 *            `[cite:trackId@start-end|caption]` → transcript blockquote +
 *            source attribution. Body is pulled from `citeLookup`; markers
 *            without a cached transcript are dropped (legacy strip).
 *  Preserved: prose (already Markdown source) and `> blockquote` runs.
 *
 * After all substitutions, runs of 3+ blank lines collapse to 2 so the
 * gaps left by stripped markers don't render as accidental section
 * breaks when pasted into a destination editor that respects paragraph
 * spacing.
 */
export function messageToMarkdown(input: string, opts: MessageToMarkdownOptions): string {
  if (!input) return ""

  let out = input
  // Widget markers with no portable text: strip the whole marker. Order
  // doesn't matter because each regex is self-contained.
  out = out.replace(CARD_RE, "")
  out = out.replace(OUTLINE_RE, "")
  out = out.replace(ACTION_RE, "")
  out = out.replace(FOLLOWUP_RE, "")
  // Chapter-location widget: chapter titles live in the body store, not
  // the message text, so there's nothing portable to expand — strip the
  // marker (same as card / outline).
  out = out.replace(CHAPTER_RE, "")
  // Media result widget: the video/audio file + transcript live in the
  // `media` SSE payload, not the message text — nothing portable to
  // expand into clipboard markdown, so strip the marker (same as
  // card / outline / chapter).
  out = out.replace(MEDIA_RE, "")
  // Audio citations: expand into a transcript blockquote + source line,
  // the cite analog of the verse expansion below. A cache miss (no
  // transcript yet) returns "" — the legacy strip behavior. Fresh
  // RegExp so the global iterator state isn't shared.
  const citeRe = new RegExp(CITE_RE.source, "g")
  out = out.replace(
    citeRe,
    (_full, trackId: string, startStr: string, endStr: string, captionRaw?: string) => {
      const body = opts.citeLookup(trackId, Number(startStr) | 0, Number(endStr) | 0)
      if (!body) return ""
      return renderCiteMarkdown(body, (captionRaw ?? "").trim())
    }
  )
  // Commentary citations: expand into a transcript-style blockquote +
  // attribution, the commentary analog of the cite expansion above. The
  // quote text lives in the body store (card-capable turns); a cache miss
  // returns "" (strip). Legacy turns embed the quote as a `>` blockquote in
  // the prose directly, so they never hit this path.
  const commentaryRe = new RegExp(COMMENTARY_RE.source, "g")
  out = out.replace(commentaryRe, (_full, refStr: string) => {
    const body = opts.commentaryLookup?.(Number(refStr) | 0)
    if (!body) return ""
    return renderCommentaryMarkdown(body)
  })
  // Verses: expand using the cache. We rebuild a fresh RegExp instead
  // of reusing VERSE_RE so the iterator state isn't shared with any
  // other consumer of the global pattern.
  const verseRe = new RegExp(VERSE_RE.source, "g")
  out = out.replace(verseRe, (_full, sourceId: string, tokens: string) => {
    const body = opts.verseLookup(sourceId, tokens)
    if (!body) return ""
    return renderVerseMarkdown(body, opts.lang)
  })

  // Collapse multi-blank gaps left behind by stripped markers and trim
  // edges. Don't touch single blank lines — those are intentional
  // paragraph breaks in the LLM's prose.
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return out
}

/**
 * Plain-Markdown rendering of one verse: bold addr label, then
 * sanskrit / transliteration / translation each on their own paragraph.
 *
 * Each multi-line field is normalised the same way `VerseCard.vue`
 * does it — collapse runs of blank lines down to a single newline.
 * Server data is inconsistent ("sometimes the sanskrit has \n\n
 * between lines, sometimes \n") and rendering raw makes every pāda
 * land in its own paragraph when pasted into Telegram / Notes etc.
 *
 * Transliteration is intentionally NOT italic-wrapped. Multi-line
 * `*…*` is invalid in CommonMark and most third-party markdown
 * engines (Telegram, Slack, GitHub) render the asterisks literally
 * across the run — uglier than plain text.
 *
 * Falls back to English translation when the requested language is
 * missing, and to any available language if English is also missing
 * — better an unexpected language than a dangling header.
 */
function renderVerseMarkdown(body: VerseBodyLike, lang: "ru" | "en"): string {
  const translation =
    body.translation[lang] ??
    body.translation.en ??
    Object.values(body.translation).find((v) => typeof v === "string" && v.length > 0) ??
    ""
  const normalise = (raw: string): string => raw.replace(/\n{2,}/g, "\n").trim()
  const parts: string[] = []
  if (body.addrLabel) parts.push(`**${body.addrLabel.trim()}**`)
  const sanskrit = normalise(body.sanskrit)
  if (sanskrit) parts.push(sanskrit)
  const transliteration = normalise(body.transliteration)
  if (transliteration) parts.push(transliteration)
  const tr = normalise(translation)
  if (tr) parts.push(tr)
  // Leading + trailing blank line so the verse sits as its own block
  // between surrounding prose paragraphs.
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}\n\n` : ""
}

/**
 * Plain-Markdown rendering of one audio citation: the transcript snippet
 * as a `>` blockquote, then a `> _attribution_` line built from the
 * resolved track meta (title · author · reference · date, mirroring the
 * order/`·` join of `ExcerptCard`). Falls back to the marker `caption`
 * when no meta has resolved yet, and omits the attribution line entirely
 * when neither is available.
 *
 * Multi-line transcript text gets each line prefixed with `> `; blank
 * lines inside the snippet collapse to one (same normalisation as the
 * verse fields) so a server snippet with `\n\n` runs doesn't shred the
 * blockquote into stacked quote blocks. Fenced by blank lines so the
 * quote stands alone between surrounding prose paragraphs.
 */
function renderCiteMarkdown(body: CiteBodyLike, caption: string): string {
  const text = body.text.replace(/\n{2,}/g, "\n").trim()
  if (!text) return ""
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

  const attribution = [body.trackTitle, body.authorName, body.reference, body.trackDate]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .join(" · ")
  const attrLine = attribution || caption

  const block = attrLine ? `${quoted}\n>\n> _${attrLine}_` : quoted
  return `\n\n${block}\n\n`
}

/**
 * Plain-Markdown rendering of one commentary citation: the cited quote as
 * a `>` blockquote, then a `> _author · reference_` attribution line —
 * the same shape `renderCiteMarkdown` uses for audio, so a copied/shared
 * answer reads consistently whether the citation was audio or a purport.
 * Blank attribution parts are dropped; an empty quote strips out.
 */
function renderCommentaryMarkdown(body: CommentaryBodyLike): string {
  const text = body.text.replace(/\n{2,}/g, "\n").trim()
  if (!text) return ""
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  const attribution = [body.authorName, body.addrLabel]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .join(" · ")
  const block = attribution ? `${quoted}\n>\n> _${attribution}_` : quoted
  return `\n\n${block}\n\n`
}
