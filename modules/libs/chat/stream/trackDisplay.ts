import type { ChatCiteReference } from "@lib/domain/chatMessage.js"
import { list, optStr, record, str } from "./wireFields.js"

/**
 * A lecture's attribution — title, author, date, scripture references —
 * which the server resolves in the answer language and attaches to `cite`,
 * `outline` and `card` actions for a client that holds no local catalog. The
 * mobile app resolves the same fields from its own database and never reads
 * these.
 */
export interface TrackDisplay {
  readonly trackTitle?: string
  readonly authorName?: string
  readonly trackDate?: string
  readonly references: readonly ChatCiteReference[]
}

/** A `[card:<track_id>]` lecture tile: the track and its attribution. */
export interface TrackCard extends TrackDisplay {
  readonly trackId: string
}

/** The attribution on an action's body; each field only when the server sent it. */
export function parseTrackDisplay(body: Record<string, unknown>): TrackDisplay {
  const trackTitle = optStr(body, "track_title")
  const authorName = optStr(body, "author_name")
  const trackDate = optStr(body, "date")
  return {
    ...(trackTitle ? { trackTitle } : {}),
    ...(authorName ? { authorName } : {}),
    ...(trackDate ? { trackDate } : {}),
    references: list(body, "references").map(parseReference).filter(isPresent),
  }
}

/** The `card` action, which carries nothing but a track and its attribution.
 *  `null` when the action is some other kind or names no track. */
export function parseTrackCard(action: Record<string, unknown>): TrackCard | null {
  if (str(action, "kind") !== "card") return null
  const body = record(action, "payload")
  const trackId = body ? str(body, "track_id") : ""
  if (!body || !trackId) return null
  return { trackId, ...parseTrackDisplay(body) }
}

/** The body of an action frame — what sits under its `payload`. */
export function actionBody(action: Record<string, unknown>): Record<string, unknown> {
  return record(action, "payload") ?? {}
}

function parseReference(raw: unknown): ChatCiteReference | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const sourceId = str(r, "source_id")
  if (!sourceId) return null
  return {
    sourceId,
    tokens: typeof r.tokens === "string" ? r.tokens : null,
    label: str(r, "label"),
  }
}

function isPresent<T>(v: T | null): v is T {
  return v !== null
}
