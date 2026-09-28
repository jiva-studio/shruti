import type {
  ChatOutlinePayload as OutlinePayload,
  ChatVersePayloadWire as VersePayload,
  ChatCiteTranscriptPayloadWire as CiteTranscriptPayload,
  ChatCommentaryPayloadWire as CommentaryPayload,
  ChatChapterPayloadWire as ChapterPayload,
  ChatMediaPayloadWire as MediaPayload,
} from "@lib/contracts"
import { flag, list, num, optStr, str, stringMap, trimmed } from "./wireFields.js"

/** One outline list-item. `@lib/contracts` inlines this inside
 *  `ChatOutlinePayload.items`; named here for the parser's local use. */
export interface OutlineItemPayload {
  readonly startMs: number
  readonly title: string
}

export function parseVersePayload(p: Record<string, unknown>): VersePayload | null {
  const sourceId = str(p, "source_id")
  const tokens = str(p, "tokens")
  if (!sourceId || !tokens) return null
  const transliterationOriginal = optStr(p, "transliteration_original")
  const lang = optStr(p, "lang")
  const audioUrl = optStr(p, "audio_url")
  return {
    source_id: sourceId,
    tokens,
    addr_label: str(p, "addr_label"),
    sanskrit: str(p, "sanskrit"),
    transliteration: str(p, "transliteration"),
    ...(transliterationOriginal ? { transliteration_original: transliterationOriginal } : {}),
    ...(lang ? { lang } : {}),
    translation: stringMap(p, "translation"),
    ...(audioUrl ? { audio_url: audioUrl } : {}),
    ...(flag(p, "mt") ? { mt: true } : {}),
  }
}

export function parseCiteTranscriptPayload(
  p: Record<string, unknown>
): CiteTranscriptPayload | null {
  const trackId = str(p, "track_id")
  const startMs = num(p, "start_ms")
  const endMs = num(p, "end_ms")
  const text = trimmed(p, "text")
  // Empty text is useless — the card would fall back to the chip anyway,
  // so drop the event rather than caching a blank snippet.
  if (!trackId || startMs === null || endMs === null || !text) return null
  const mt = flag(p, "mt")
  const textOriginal = mt ? optStr(p, "text_original") : undefined
  return {
    track_id: trackId,
    start_ms: startMs,
    end_ms: endMs,
    text,
    ...(mt ? { mt: true } : {}),
    ...(textOriginal ? { text_original: textOriginal } : {}),
  }
}

export function parseCommentaryPayload(p: Record<string, unknown>): CommentaryPayload | null {
  const ref = num(p, "ref")
  const text = trimmed(p, "text")
  // No ref or empty text ⇒ the card has nothing to render; drop the event.
  if (ref === null || !text) return null
  const mt = flag(p, "mt")
  const textOriginal = mt ? optStr(p, "text_original") : undefined
  return {
    ref,
    text,
    author_name: str(p, "author_name"),
    addr_label: str(p, "addr_label"),
    kind: str(p, "kind", "commentary"),
    ...(mt ? { mt: true } : {}),
    ...(textOriginal ? { text_original: textOriginal } : {}),
  }
}

export function parseChapterPayload(p: Record<string, unknown>): ChapterPayload | null {
  const sourceId = str(p, "source_id")
  // region_token may be "" for book-level regions (e.g. BG) — that's valid.
  const regionToken = typeof p.region_token === "string" ? p.region_token : null
  if (!sourceId || regionToken === null) return null
  const chapters = list(p, "chapters").map(parseChapterEntry).filter(isPresent)
  if (chapters.length === 0) return null
  return {
    source_id: sourceId,
    region_token: regionToken,
    region_label: str(p, "region_label"),
    chapters,
    ...(flag(p, "mt") ? { mt: true } : {}),
  }
}

interface ChapterEntry {
  tokens: string
  title: string
  title_original?: string
}

/** `title_original` is present only when the server translated the title;
 *  kept so the card can offer the same "view original" flip as every other
 *  translated card in the bubble. */
function parseChapterEntry(raw: unknown): ChapterEntry | null {
  if (!raw || typeof raw !== "object") return null
  const entry = raw as Record<string, unknown>
  const tokens = str(entry, "tokens")
  if (!tokens) return null
  const titleOriginal = optStr(entry, "title_original")
  return {
    tokens,
    title: str(entry, "title"),
    ...(titleOriginal ? { title_original: titleOriginal } : {}),
  }
}

/** A key only when the server sent a value for it. */
function present(key: string, v: string | undefined): Record<string, string> {
  return v ? { [key]: v } : {}
}

function isPresent<T>(v: T | null): v is T {
  return v !== null
}

export function parseMediaPayload(p: Record<string, unknown>): MediaPayload | null {
  const id = str(p, "id")
  const url = str(p, "url")
  const typeRaw = str(p, "type")
  const type = typeRaw === "video" || typeRaw === "audio" ? typeRaw : null
  // A media card with no file or an unknown type is useless — drop the
  // event rather than render an empty/broken player.
  if (!id || !url || type === null) return null
  const mt = flag(p, "mt")
  return {
    id,
    url,
    type,
    title: str(p, "title"),
    text: str(p, "text"),
    ...present("speaker", optStr(p, "speaker")),
    // Half the attribution line; without it the card renders the server's
    // "<speaker> · <date>" label as both the title and the attribution.
    ...present("date", optStr(p, "date")),
    ...(mt ? { mt: true } : {}),
    ...present("text_original", mt ? optStr(p, "text_original") : undefined),
  }
}

export function parseOutlinePayload(p: Record<string, unknown>): OutlinePayload | null {
  const trackId = str(p, "track_id")
  if (!trackId) return null
  const items = list(p, "items").map(parseOutlineItem).filter(isPresent)
  if (items.length === 0) return null
  return { trackId, items }
}

function parseOutlineItem(raw: unknown): OutlineItemPayload | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const startMs = num(obj, "start_ms")
  const title = trimmed(obj, "title")
  return startMs !== null && title ? { startMs, title } : null
}
