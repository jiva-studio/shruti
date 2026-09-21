import type {
  ChatAttribute,
  ChatAttributes,
  ChatStreamEvent,
  ResearchSourceKind,
} from "@lib/contracts"
import { eitherNum, eitherStr, num, optStr, str, trimmed } from "./wireFields.js"
import { parseActionPayload } from "./sseActionParser.js"

/** One outline list-item. `@lib/contracts` inlines this inside
 *  `ChatOutlinePayload.items`; named here for the parser's local use. */
export interface OutlineItemPayload {
  readonly startMs: number
  readonly title: string
}

/** The alias map the server ships inline with `done`. */
interface AliasMapPayload {
  readonly [alias: string]: {
    readonly track_id: string
    readonly start_ms?: number
    readonly end_ms?: number
  }
}

export function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n")
  const crlf = buffer.indexOf("\r\n\r\n")
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

/**
 * Parse a single SSE event block into the typed shape. We tolerate
 * missing `event:` (default to `delta`) and multi-line `data:` (joined
 * with newline per the SSE spec, then parsed as JSON).
 */
/** One decoded SSE frame: its event name and its JSON body. */
interface SseFrame {
  readonly name: string
  readonly payload: Record<string, unknown>
}

/**
 * Read one frame off the block. `null` when the body did not parse and the
 * event was not a delta — text-only delta is a documented fallback in the
 * wire protocol, so a non-JSON delta still reaches the user; anything else
 * with a malformed body is a server bug, logged rather than swallowed.
 */
function readSseFrame(block: string): SseFrame | ChatStreamEvent | null {
  let eventName: string | null = null
  const dataLines: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith(":") || line === "") continue
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""))
  }
  const name = eventName ?? "delta"
  const dataRaw = dataLines.join("\n")
  if (!dataRaw) return { name, payload: {} }
  try {
    return { name, payload: JSON.parse(dataRaw) as Record<string, unknown> }
  } catch {
    if (name === "delta") return { type: "delta", text: dataRaw }
    console.warn("chatClient: malformed SSE event payload", { event: name, bytes: dataRaw.length })
    return null
  }
}

type EventParser = (p: Record<string, unknown>) => ChatStreamEvent | null

const EVENT_PARSERS: Record<string, EventParser> = {
  delta: (p) => ({ type: "delta", text: str(p, "text") }),
  tool_start: (p) => ({ type: "tool_start", name: optStr(p, "name") }),
  tool_end: (p) => ({ type: "tool_end", name: optStr(p, "name") }),
  status: (p) => ({ type: "status", key: str(p, "key"), params: parseStatusParams(p.params) }),
  done: parseDoneEvent,
  action: (p) => {
    const ap = parseActionPayload(p)
    return ap ? { type: "action", payload: ap } : null
  },
  research_question: parseResearchQuestion,
  research_source: parseResearchSource,
  error: parseErrorEvent,
  usage: parseUsageEvent,
}

export function parseSseBlock(block: string): ChatStreamEvent | null {
  const frame = readSseFrame(block)
  if (frame === null) return null
  if ("type" in frame) return frame
  // `hasOwn`, not a truthiness check: an event named `toString` finds
  // Object.prototype's and would be invoked as if it were a parser.
  const parse = Object.hasOwn(EVENT_PARSERS, frame.name) ? EVENT_PARSERS[frame.name] : undefined
  if (!parse) {
    console.warn("[chat] unknown sse event:", frame.name)
    return null
  }
  return parse(frame.payload)
}

function parseDoneEvent(p: Record<string, unknown>): ChatStreamEvent {
  const aliases = parseAliasMap(p.aliases)
  const attributes = parseAttributes(p.attributes)
  return {
    type: "done",
    ...(aliases ? { aliases } : {}),
    ...(attributes ? { attributes } : {}),
  }
}

function parseResearchQuestion(p: Record<string, unknown>): ChatStreamEvent | null {
  const question = trimmed(p, "question")
  return question ? { type: "research_question", question } : null
}

/** The wire field is `kind`; renamed on the decoded shape so it does not
 *  collide with the `kind` discriminator on an action payload. */
function parseResearchSource(p: Record<string, unknown>): ChatStreamEvent | null {
  const wireKind = str(p, "kind")
  if (wireKind !== "verse" && wireKind !== "lecture_chunk" && wireKind !== "library_doc") {
    return null
  }
  const id = trimmed(p, "id")
  if (!id) return null
  return {
    type: "research_source",
    sourceKind: wireKind as ResearchSourceKind,
    id,
    label: trimmed(p, "label"),
  }
}

/**
 * A rate-limited error carries the tier and the reset time, and since the
 * usage chip hydrates mid-stream, the counts and the key type as well.
 * Without them the bubble falls through to the generic "could not get a
 * response" copy and the user only learns the real reason after a retry.
 */
function parseErrorEvent(p: Record<string, unknown>): ChatStreamEvent {
  const tier = optStr(p, "tier")
  const resetsAtEpoch = eitherNum(p, "resets_at_epoch", "resetsAtEpoch")
  const current = num(p, "current") ?? undefined
  const limit = num(p, "limit") ?? undefined
  const keyTypeRaw = eitherStr(p, "key_type", "keyType")
  const keyType = keyTypeRaw === "user" || keyTypeRaw === "ip" ? keyTypeRaw : undefined
  return {
    type: "error",
    code: str(p, "code", "unknown"),
    message: str(p, "message"),
    retryAfter: eitherNum(p, "retry_after", "retryAfter"),
    ...(tier !== undefined ? { tier } : {}),
    ...(resetsAtEpoch !== undefined ? { resetsAtEpoch } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(keyType !== undefined ? { keyType } : {}),
  }
}

/** All four fields or nothing: a chip reading `-1/-1` is worse than no chip. */
function parseUsageEvent(p: Record<string, unknown>): ChatStreamEvent | null {
  const current = num(p, "current") ?? -1
  const limit = num(p, "limit") ?? -1
  const resetsAtEpoch = eitherNum(p, "resets_at_epoch", "resetsAtEpoch") ?? -1
  if (current < 0 || limit <= 0 || resetsAtEpoch <= 0) return null
  return { type: "usage", scope: str(p, "scope", "chat"), current, limit, resetsAtEpoch }
}

function parseStatusParams(raw: unknown): Readonly<Record<string, string | number>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseAliasMap(raw: unknown): AliasMapPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, { track_id: string; start_ms?: number; end_ms?: number }> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const obj = v as Record<string, unknown>
    if (typeof obj.track_id !== "string") continue
    const entry: { track_id: string; start_ms?: number; end_ms?: number } = {
      track_id: obj.track_id,
    }
    if (typeof obj.start_ms === "number") entry.start_ms = obj.start_ms
    if (typeof obj.end_ms === "number") entry.end_ms = obj.end_ms
    out[k] = entry
  }
  return out
}

function parseAttributes(raw: unknown): ChatAttributes | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, ChatAttribute> = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const attr = parseAttribute(v)
    // An unknown KEY is kept and carried forward — that is what lets the
    // server add an attribute without a client release.
    if (attr) out[key] = attr
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * One settled attribute. The server sends one only when it actually settled,
 * so an empty value is a malformed frame. The value is isomorphic — a string
 * when single-valued, an array when multi — and is kept in the shape it
 * arrived in. Trimmed, blanks dropped, de-duplicated keeping order: the same
 * normalisation the server applies, so a stored attribute is clean on both
 * sides.
 */
function parseAttribute(v: unknown): ChatAttribute | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const rawValue = o.value
  const listed = typeof rawValue === "string" ? [rawValue] : asStrings(rawValue)
  const clean = [...new Set(listed.map((x) => x.trim()).filter((x) => x.length > 0))]
  if (clean.length === 0) return null
  return {
    value: typeof rawValue === "string" ? clean[0]! : clean,
    label: str(o, "label"),
    explicit: o.explicit === true,
  }
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}
