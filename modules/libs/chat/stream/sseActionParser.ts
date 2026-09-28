import type {
  ChatActionPayload as ActionPayload,
  ChatSharePdfRefPayload as SharePdfRefPayload,
  ChatSharePdfItemPayload as SharePdfItemPayload,
} from "@lib/contracts"
import { list, record, str } from "./wireFields.js"
import {
  parseChapterPayload,
  parseCiteTranscriptPayload,
  parseCommentaryPayload,
  parseMediaPayload,
  parseOutlinePayload,
  parseVersePayload,
} from "./ssePayloadParsers.js"

/** Kinds whose body is one of the card payloads, fanned out by the use-case
 *  into its own event stream rather than persisted as an action. */
const CARD_PARSERS: Record<string, (body: Record<string, unknown>) => unknown> = {
  outline: parseOutlinePayload,
  verse: parseVersePayload,
  cite_transcript: parseCiteTranscriptPayload,
  chapter: parseChapterPayload,
  media: parseMediaPayload,
  commentary: parseCommentaryPayload,
}

/** Kinds that render a widget the user acts on. */
const WIDGET_PARSERS: Record<
  string,
  (id: string, body: Record<string, unknown>) => ActionPayload | null
> = {
  share_pdf: parseSharePdf,
  enable_daily_reminder: parseDailyReminder,
  configure_smart_library: parseSmartLibrary,
  upgrade_to_pro: parseUpgradeToPro,
  add_to_library: parseAddToLibrary,
}

/**
 * The kind-specific body lives under `payload`. A flat older shape is
 * rejected: the protocol handshake guarantees the server speaks the current
 * version, so a flat event is a server bug rather than a compatibility case.
 */
export function parseActionPayload(p: Record<string, unknown>): ActionPayload | null {
  const kind = str(p, "kind")
  const id = str(p, "id")
  if (!kind || !id) return null
  const body = record(p, "payload")
  if (!body) return null

  // `hasOwn`, not a truthiness check: a kind named `toString` finds
  // Object.prototype's and would be invoked as if it were a parser.
  if (Object.hasOwn(CARD_PARSERS, kind)) {
    const payload = CARD_PARSERS[kind]!(body)
    return payload ? ({ kind, id, payload } as ActionPayload) : null
  }
  if (!Object.hasOwn(WIDGET_PARSERS, kind)) return null
  return WIDGET_PARSERS[kind]!(id, body)
}

function parseSharePdf(id: string, body: Record<string, unknown>): ActionPayload | null {
  const items = list(body, "items").map(parseSharePdfItem).filter(isPresent)
  if (items.length === 0) return null
  return { kind: "share_pdf", id, payload: { items } }
}

function parseSharePdfItem(raw: unknown): SharePdfItemPayload | null {
  if (!raw || typeof raw !== "object") return null
  const it = raw as Record<string, unknown>
  const trackId = str(it, "track_id")
  const transcriptKey = str(it, "transcript_key")
  if (!trackId || !transcriptKey) return null
  return {
    trackId,
    lang: str(it, "lang"),
    title: str(it, "title") || trackId,
    author: orNull(it, "author"),
    date: orNull(it, "date"),
    location: orNull(it, "location"),
    references: list(it, "references").map(parseSharePdfRef).filter(isPresent),
    tags: strings(list(it, "tags")),
    transcriptKey,
  }
}

function parseSharePdfRef(raw: unknown): SharePdfRefPayload | null {
  if (!raw || typeof raw !== "object") return null
  const ro = raw as Record<string, unknown>
  return {
    shortName: orNull(ro, "short_name"),
    fullName: orNull(ro, "full_name"),
    sourceId: orNull(ro, "source_id"),
    tokens: orNull(ro, "tokens"),
  }
}

/** Bounded HH:MM. An out-of-range time is rejected here so it falls back to
 *  the default instead of rendering a card that throws on Confirm — the
 *  executor re-validates with the same bounds. */
function parseDailyReminder(id: string, body: Record<string, unknown>): ActionPayload {
  const raw = str(body, "time")
  const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : "07:00"
  return { kind: "enable_daily_reminder", id, payload: { time } }
}

function parseSmartLibrary(id: string, body: Record<string, unknown>): ActionPayload {
  const f = record(body, "filters") ?? {}
  return {
    kind: "configure_smart_library",
    id,
    payload: {
      filters: {
        authorIds: someStrings(f.author_ids),
        tagIds: someStrings(f.tag_ids),
        sourceIds: someStrings(f.source_ids),
        locationIds: someStrings(f.location_ids),
        languageCodes: someStrings(f.language_codes),
      },
    },
  }
}

function parseUpgradeToPro(id: string, body: Record<string, unknown>): ActionPayload {
  return { kind: "upgrade_to_pro", id, payload: { reason: str(body, "reason") || "generic" } }
}

function parseAddToLibrary(id: string, body: Record<string, unknown>): ActionPayload | null {
  const url = str(body, "url")
  if (!url) return null
  return {
    kind: "add_to_library",
    id,
    payload: {
      url,
      title: str(body, "title"),
      author: orNull(body, "author"),
      thumbnail: orNull(body, "thumbnail"),
    },
  }
}

function orNull(p: Record<string, unknown>, key: string): string | null {
  return typeof p[key] === "string" ? (p[key] as string) : null
}

function strings(xs: readonly unknown[]): readonly string[] {
  return xs.filter((x): x is string => typeof x === "string")
}

/** A filter the server did not send at all, versus one it sent empty. */
function someStrings(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const xs = strings(v)
  return xs.length > 0 ? xs : undefined
}

function isPresent<T>(v: T | null): v is T {
  return v !== null
}
