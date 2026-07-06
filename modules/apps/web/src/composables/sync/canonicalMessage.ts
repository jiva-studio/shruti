/**
 * Web ↔ canonical chat-message envelope conversion.
 *
 * The `profile` sync wire, and the mobile app, store a chat message as
 * `content` (raw markdown) plus a `meta` JSON envelope `{"_v":1,"data":{…}}`
 * whose keys are the domain field names (camelCase). This module maps the
 * web client's `SerializedMsg` (the localStorage cache shape, whose rich
 * fields are `[key,value][]` entry arrays) to and from that canonical
 * envelope so a message the web pushes renders on mobile — and one the web
 * pulls from mobile renders here.
 *
 * Six card collections are SHARED with mobile and go straight into
 * `meta.data` (verses/chapters/cites/commentaries/media/outlines) so both
 * apps render them from the same bytes; `aliases` is shared too. Web-only
 * rich fields (cards/pdfActions/researchSources/researchQuestions and the
 * transient statusKey/traceId) are stashed under an additive `meta.data.web`
 * key — the mobile `parseMeta` ignores unknown keys, so they round-trip on
 * the web without disturbing mobile.
 *
 * The shared `wrapMeta`/`parseMeta` codec (`@lib/domain/chat/messageMeta`) is
 * reused for the canonical fields so the shared shape can never drift.
 *
 * Pure — no Vue, no IO. Unit-tested in `__tests__/profileSyncCore.test.ts`.
 */

import { parseMeta, wrapMeta } from "@lib/domain/chat/messageMeta.js"
import type { SerializedMsg } from "../useChatHistory"

/** Rich card fields shared with the mobile canonical envelope. Stored on a
 *  `SerializedMsg` as `[key,value][]` entry arrays and mirrored 1:1 into
 *  `meta.data` as `Record<string, …>`. */
const SHARED_CARD_FIELDS = [
  "verses",
  "chapters",
  "cites",
  "commentaries",
  "media",
  "outlines",
] as const

/** Web-only rich fields with no mobile home; nested under `meta.data.web`. */
const WEB_CARD_FIELDS = ["cards", "pdfActions", "researchSources"] as const

type Entries = [string, unknown][]

function entriesToRecord(entries: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const rec: Record<string, unknown> = {}
  for (const pair of entries as Entries) {
    if (Array.isArray(pair) && typeof pair[0] === "string") rec[pair[0]] = pair[1]
  }
  return Object.keys(rec).length > 0 ? rec : undefined
}

function recordToEntries(rec: unknown): Entries | undefined {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return undefined
  const entries = Object.entries(rec as Record<string, unknown>)
  return entries.length > 0 ? entries : undefined
}

/**
 * Serialize a web message's rich fields into the canonical `meta` JSON
 * string. The six shared card records go through the shared `wrapMeta` (so
 * their empty-omission / shape matches mobile exactly); web-only fields are
 * spliced under `data.web`.
 */
export function richFieldsToMeta(m: SerializedMsg): string {
  const shared: Parameters<typeof wrapMeta>[0] = {}
  for (const f of SHARED_CARD_FIELDS) {
    const rec = entriesToRecord(m[f])
    if (rec) (shared as Record<string, unknown>)[f] = rec
  }
  const aliases =
    m.aliases && typeof m.aliases === "object" && Object.keys(m.aliases).length > 0
      ? (m.aliases as Record<string, never>)
      : undefined
  if (aliases) shared.aliases = aliases

  const web: Record<string, unknown> = {}
  for (const f of WEB_CARD_FIELDS) {
    const rec = entriesToRecord(m[f])
    if (rec) web[f] = rec
  }
  if (Array.isArray(m.researchQuestions) && m.researchQuestions.length > 0) {
    web.researchQuestions = m.researchQuestions
  }
  if (typeof m.statusKey === "string" && m.statusKey) web.statusKey = m.statusKey
  if (typeof m.traceId === "string" && m.traceId) web.traceId = m.traceId

  // Reuse the shared codec for the canonical part, then add the web-only
  // namespace. Parse-and-augment keeps the shared bytes identical to mobile's.
  const base = JSON.parse(wrapMeta(shared)) as { _v: number; data: Record<string, unknown> }
  if (Object.keys(web).length > 0) base.data.web = web
  return JSON.stringify(base)
}

/**
 * Parse a canonical `meta` string back into a web message's rich fields
 * (as `[key,value][]` entry arrays, ready to drop onto a `SerializedMsg`).
 * Shared fields come through the shared `parseMeta`; web-only fields are
 * read from `data.web`. Unknown/foreign fields (mobile `actions`, `focus`,
 * `feedback`, …) are simply not surfaced — the web has no renderer for them.
 */
export function metaToRichFields(meta: string | null | undefined): Partial<SerializedMsg> {
  const out: Record<string, unknown> = {}
  const canon = parseMeta(meta)
  for (const f of SHARED_CARD_FIELDS) {
    const entries = recordToEntries((canon as Record<string, unknown>)[f])
    if (entries) out[f] = entries
  }
  if (canon.aliases && Object.keys(canon.aliases).length > 0) out.aliases = canon.aliases

  // Web-only namespace — parse the raw envelope, since `parseMeta` drops it.
  let web: Record<string, unknown> = {}
  if (typeof meta === "string" && meta) {
    try {
      const raw = JSON.parse(meta) as { data?: { web?: unknown } } | null
      const w = raw?.data?.web
      if (w && typeof w === "object" && !Array.isArray(w)) web = w as Record<string, unknown>
    } catch {
      /* malformed — no web extras */
    }
  }
  for (const f of WEB_CARD_FIELDS) {
    const entries = recordToEntries(web[f])
    if (entries) out[f] = entries
  }
  if (Array.isArray(web.researchQuestions)) {
    out.researchQuestions = (web.researchQuestions as unknown[]).filter(
      (x): x is string => typeof x === "string"
    )
  }
  if (typeof web.statusKey === "string") out.statusKey = web.statusKey
  if (typeof web.traceId === "string") out.traceId = web.traceId

  return out as Partial<SerializedMsg>
}

/* -------------------------------------------------------------------------- */
/*  Wire row builders (the opaque `data` blob for a sync Change)              */
/* -------------------------------------------------------------------------- */

/** The `chat_messages` wire row (`data` of a Change), snake_case per the
 *  server's typed projection. */
export interface ChatMessageWireData {
  session_id: string
  role: "user" | "assistant"
  content: string
  meta: string
  created_at: number
}

/** The `chat_sessions` wire row. */
export interface ChatSessionWireData {
  title: string | null
  track_id: string | null
  created_at: number
  updated_at: number
}

export function messageToWireData(sessionId: string, m: SerializedMsg): ChatMessageWireData {
  return {
    session_id: sessionId,
    role: m.role,
    content: m.text,
    meta: richFieldsToMeta(m),
    created_at: typeof m.createdAt === "number" ? m.createdAt : 0,
  }
}

/** Parse a pulled `chat_messages` row into a `SerializedMsg`. `docId` is the
 *  server doc id — the stable message id. */
export function wireDataToMessage(docId: string, data: unknown): SerializedMsg | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  const role = d.role === "assistant" ? "assistant" : d.role === "user" ? "user" : null
  if (!role) return null
  const msg: SerializedMsg = {
    id: docId,
    role,
    text: typeof d.content === "string" ? d.content : "",
    createdAt: toMs(d.created_at),
    ...metaToRichFields(typeof d.meta === "string" ? d.meta : null),
  }
  return msg
}

export function sessionToWireData(
  chat: { title: string | null; updatedAt: number; createdAt?: number; trackId?: string | null },
): ChatSessionWireData {
  return {
    title: chat.title,
    track_id: chat.trackId ?? null,
    created_at: typeof chat.createdAt === "number" ? chat.createdAt : chat.updatedAt,
    updated_at: chat.updatedAt,
  }
}

/** ISO-8601 string or epoch → ms. Numbers under ~1e12 are treated as seconds. */
export function toMs(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v
  if (typeof v === "string") {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
