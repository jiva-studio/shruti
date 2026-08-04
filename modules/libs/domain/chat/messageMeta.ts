/**
 * Chat-message `meta` envelope codec — the single source of truth for the
 * `{"_v":1,"data":{…}}` JSON blob that carries an assistant message's rich
 * card payloads.
 *
 * `content` (the raw markdown with inline `[cite:…]` / `[verse:…]` /
 * `[media:…]` / `[action:…|id=…]` / `[outline:…]` / `[followup:…]` markers)
 * lives in its OWN column; this envelope holds only the payloads keyed by
 * marker id, so the bubble renderer rebuilds the same UI tokens after a
 * reload. Keys inside `data` are the domain field names verbatim
 * (camelCase); empty fields are omitted, so a card-less message serializes
 * to exactly `{"_v":1,"data":{}}`.
 *
 * This module is the CANONICAL format shared by every client:
 *  - the mobile SQL repository (`chatMessagesRepository.sql.ts`) reads/writes
 *    the `chat_messages.meta` column through it;
 *  - the web client persists + syncs the same envelope so a message renders
 *    identically on both, and the `profile` service stores the string
 *    byte-verbatim.
 *
 * `parseMeta` tolerates unknown keys (it extracts only the fields it knows),
 * so a client MAY add its own additive keys to `data` — another client's
 * parse just ignores them. `_v > CURRENT_META_V` renders empty rather than
 * crashing (forward-compat with a newer writer).
 *
 * Pure value logic — no IO, no infra imports. Keep byte-compatible: the
 * mobile repository's tests pin the serialized shape.
 */

import type {
  ChatActionPayload,
  ChatActionState,
  ChatAliasEntry,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatFeedbackCategory,
  ChatFocusPayload,
  ChatMessageError,
  ChatOutlinePayload,
  ChatAttributes,
  ChatVerseBody,
  MediaPayload,
} from "../chatMessage.js"
import type { TrackId } from "../core.js"
import type { ChatFeedbackState } from "../ports/chatMessageRepository.js"

const FEEDBACK_CATEGORIES: ReadonlySet<ChatFeedbackCategory> = new Set([
  "off_topic",
  "no_results",
  "bad_citations",
  "wrong_language",
  "factually_wrong",
  "other",
])

/** Schema version of the JSON-blob envelope. Bump when payload shapes
 *  evolve non-additively; `parseMeta` handles `_v > known` by rendering
 *  empty (forward-compat with newer apps writing the row). */
export const CURRENT_META_V = 1

export interface ParsedMeta {
  readonly actions: Record<string, ChatActionPayload>
  readonly outlines: Record<string, ChatOutlinePayload>
  readonly media: Record<string, MediaPayload>
  readonly verses: Record<string, ChatVerseBody>
  readonly cites: Record<string, ChatCiteSnippet>
  readonly chapters: Record<string, ChatChapterBody>
  readonly commentaries: Record<string, ChatCommentaryBody>
  readonly actionStates: Record<string, ChatActionState>
  readonly followups: readonly string[]
  readonly error: ChatMessageError | undefined
  readonly aliases: Record<string, ChatAliasEntry> | undefined
  readonly focus: ChatFocusPayload | undefined
  readonly feedback: ChatFeedbackState | undefined
  readonly attributes: ChatAttributes | undefined
}

export const EMPTY_META: ParsedMeta = Object.freeze({
  actions: {},
  outlines: {},
  media: {},
  verses: {},
  cites: {},
  chapters: {},
  commentaries: {},
  actionStates: {},
  followups: [],
  error: undefined,
  aliases: undefined,
  focus: undefined,
  feedback: undefined,
  attributes: undefined,
})

export function parseMeta(raw: unknown): ParsedMeta {
  if (typeof raw !== "string" || raw === "") return EMPTY_META
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_META
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_META
  const obj = parsed as Record<string, unknown>
  if (typeof obj._v !== "number" || obj._v > CURRENT_META_V) {
    // Newer schema — bubble renderer falls back to empty rather than
    // crashing on missing fields.
    return EMPTY_META
  }
  const data =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : {}
  return {
    actions: extractRecord<ChatActionPayload>(data.actions),
    outlines: extractRecord<ChatOutlinePayload>(data.outlines),
    media: extractRecord<MediaPayload>(data.media),
    verses: extractRecord<ChatVerseBody>(data.verses),
    cites: extractRecord<ChatCiteSnippet>(data.cites),
    chapters: extractRecord<ChatChapterBody>(data.chapters),
    commentaries: extractRecord<ChatCommentaryBody>(data.commentaries),
    actionStates: extractRecord<ChatActionState>(data.actionStates),
    followups: extractFollowups(data.followups),
    error: parseError(data.error),
    aliases: extractAliases(data.aliases),
    focus: extractFocus(data.focus),
    feedback: extractFeedback(data.feedback),
    attributes: extractAttributes(data.attributes),
  }
}

function extractAttributes(raw: unknown): ChatAttributes | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, { value: string; label: string; explicit: boolean }> = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    // The server only sends an attribute it actually settled, so an empty
    // value is a corrupt row. Unknown KEYS are kept: this build does not need
    // to understand an attribute to carry it forward.
    if (typeof o.value !== "string" || o.value === "") continue
    out[key] = {
      value: o.value,
      label: typeof o.label === "string" ? o.label : "",
      explicit: o.explicit === true,
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function extractFeedback(raw: unknown): ChatFeedbackState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o.state !== "up" && o.state !== "down") return undefined
  const out: { state: "up" | "down"; category?: ChatFeedbackCategory; comment?: string } = {
    state: o.state,
  }
  if (
    typeof o.category === "string" &&
    FEEDBACK_CATEGORIES.has(o.category as ChatFeedbackCategory)
  ) {
    out.category = o.category as ChatFeedbackCategory
  }
  if (typeof o.comment === "string" && o.comment.length > 0) out.comment = o.comment
  return out
}

function extractFocus(raw: unknown): ChatFocusPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.trackId !== "string") return undefined
  if (typeof o.startMs !== "number" || typeof o.endMs !== "number") return undefined
  if (typeof o.text !== "string") return undefined
  const out: {
    trackId: TrackId
    startMs: number
    endMs: number
    text: string
    sourceKey?: string
    trackTitle?: string
    authorName?: string
    date?: string
    location?: string
  } = {
    trackId: o.trackId as TrackId,
    startMs: o.startMs,
    endMs: o.endMs,
    text: o.text,
  }
  if (typeof o.sourceKey === "string") out.sourceKey = o.sourceKey
  if (typeof o.trackTitle === "string") out.trackTitle = o.trackTitle
  if (typeof o.authorName === "string") out.authorName = o.authorName
  if (typeof o.date === "string") out.date = o.date
  if (typeof o.location === "string") out.location = o.location
  return out
}

function extractAliases(raw: unknown): Record<string, ChatAliasEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, ChatAliasEntry> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const o = v as Record<string, unknown>
    if (typeof o.trackId !== "string") continue
    const entry: { trackId: string; startMs?: number; endMs?: number } = {
      trackId: o.trackId,
    }
    if (typeof o.startMs === "number") entry.startMs = o.startMs
    if (typeof o.endMs === "number") entry.endMs = o.endMs
    out[k] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function extractRecord<T>(raw: unknown): Record<string, T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Record<string, T>
}

function extractFollowups(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0)
}

function parseError(raw: unknown): ChatMessageError | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  if (obj.kind === "truncated" && (obj.reason === "stream" || obj.reason === "turns")) {
    return { kind: "truncated", reason: obj.reason }
  }
  // User tapped stop mid-stream. Round-trips through SQL so the
  // partial bubble survives cold-start (the user explicitly preserved
  // that prose by stopping rather than letting it continue).
  if (obj.kind === "stopped") {
    return { kind: "stopped" }
  }
  // `failed` is intentionally NOT in the whitelist — failed bubbles
  // are not useful history; they live in memory only and the reload
  // surfaces a clean assistant gap instead.
  // Unknown kind → caller sees `undefined` and renders no error suffix.
  return undefined
}

export function wrapMeta(payload: {
  actions?: Record<string, ChatActionPayload>
  outlines?: Record<string, ChatOutlinePayload>
  media?: Record<string, MediaPayload>
  verses?: Record<string, ChatVerseBody>
  cites?: Record<string, ChatCiteSnippet>
  chapters?: Record<string, ChatChapterBody>
  commentaries?: Record<string, ChatCommentaryBody>
  actionStates?: Record<string, ChatActionState>
  followups?: readonly string[]
  error?: ChatMessageError | undefined
  aliases?: Record<string, ChatAliasEntry>
  focus?: ChatFocusPayload
  feedback?: ChatFeedbackState
  attributes?: ChatAttributes
}): string {
  const data: Record<string, unknown> = {}
  if (payload.actions && Object.keys(payload.actions).length > 0) data.actions = payload.actions
  if (payload.outlines && Object.keys(payload.outlines).length > 0) data.outlines = payload.outlines
  if (payload.media && Object.keys(payload.media).length > 0) data.media = payload.media
  if (payload.verses && Object.keys(payload.verses).length > 0) data.verses = payload.verses
  if (payload.cites && Object.keys(payload.cites).length > 0) data.cites = payload.cites
  if (payload.chapters && Object.keys(payload.chapters).length > 0) data.chapters = payload.chapters
  if (payload.commentaries && Object.keys(payload.commentaries).length > 0)
    data.commentaries = payload.commentaries
  if (payload.actionStates && Object.keys(payload.actionStates).length > 0)
    data.actionStates = payload.actionStates
  if (payload.followups && payload.followups.length > 0) data.followups = payload.followups
  if (payload.error) data.error = payload.error
  if (payload.aliases && Object.keys(payload.aliases).length > 0) data.aliases = payload.aliases
  if (payload.focus) data.focus = payload.focus
  if (payload.feedback) data.feedback = payload.feedback
  if (payload.attributes && Object.keys(payload.attributes).length > 0)
    data.attributes = payload.attributes
  return JSON.stringify({ _v: CURRENT_META_V, data })
}
