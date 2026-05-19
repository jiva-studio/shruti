import { useLectorium } from "@lectorium/lectorium.js"

/* -------------------------------------------------------------------------- */
/*                              Wire-protocol types                           */
/* -------------------------------------------------------------------------- */

export type ChatRole = "user" | "assistant"

export interface ChatTurn {
  readonly role: ChatRole
  readonly content: string
  /** Round-tripped from a prior turn's `aliases` SSE event. Only
   *  present on assistant turns whose `meta.aliases` was persisted.
   *  Domain stays camelCase; `buildRequestBody` converts to the wire
   *  snake_case shape before sending. */
  readonly aliases?: Readonly<
    Record<string, { readonly trackId: string; readonly startMs?: number; readonly endMs?: number }>
  >
}

export interface OutlineItemPayload {
  readonly startMs: number
  readonly title: string
}

export interface OutlinePayload {
  readonly trackId: string
  readonly items: readonly OutlineItemPayload[]
}

export interface SharePdfItemPayload {
  readonly trackId: string
  readonly lang: string
  readonly title: string
  readonly author: string | null
  readonly date: string | null
  readonly pdfUrl: string
}

export type ActionPayload =
  | {
      readonly kind: "create_playlist"
      readonly id: string
      readonly name: string
      readonly trackIds: readonly string[]
    }
  | {
      readonly kind: "share_pdf"
      readonly id: string
      readonly items: readonly SharePdfItemPayload[]
    }
  // Hint-class actions the LLM can emit inline during normal user
  // conversations. The mobile cards (ActionCardEnableReminder /
  // ActionCardConfigureSmartLibrary / ActionCardUpgradeToPro) handle
  // rendering; the chat store also writes a `chat_messages_proactive_state`
  // row when one of these arrives so the autonomous tutorial scheduler
  // sees a recent firing and respects the 30-day cooldown.
  | {
      readonly kind: "enable_daily_reminder"
      readonly id: string
      /** `'HH:mm'` 24h local time. */
      readonly time: string
    }
  | {
      readonly kind: "configure_smart_library"
      readonly id: string
      readonly filters: {
        readonly authorIds?: readonly string[]
        readonly tagIds?: readonly string[]
        readonly sourceIds?: readonly string[]
        readonly locationIds?: readonly string[]
        readonly languageCodes?: readonly string[]
      }
    }
  | {
      readonly kind: "upgrade_to_pro"
      readonly id: string
      readonly reason: string
    }

/**
 * Decoded SSE events. `tool_start`, `tool`, `done` carry no payload —
 * the event type alone is the signal. Server-side metrics (tokens,
 * tool durations, request id) live in structured logs, not on the
 * wire.
 */
export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool_start" }
  | { readonly type: "tool" }
  | { readonly type: "action"; readonly payload: ActionPayload }
  | { readonly type: "outline"; readonly payload: OutlinePayload }
  /** Emitted once per turn, right before `done`. Carries the
   *  integer→chunk map the server used to expand `[cite:N|…]` /
   *  `[card:N]` / `[outline:N]` into the wire-format markers in
   *  this turn's `delta` text. Persisting it on the freshly-finalised
   *  assistant message lets us ship it back as `aliases` on the
   *  message in the next turn's history, so the LLM sees one
   *  numbering scheme throughout the conversation. */
  | { readonly type: "aliases"; readonly map: AliasMapPayload }
  | { readonly type: "done" }
  | {
      readonly type: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
    }

/** Wire shape of the alias map emitted by the agent. Keys are integer
 *  aliases serialised as strings (JSON limitation); start/end ms are
 *  present only for cite-level chunk aliases. Wire layer keeps the
 *  snake_case from the agent payload; the domain layer maps it to
 *  camelCase `ChatAliasEntry`. */
export interface AliasMapPayload {
  readonly [refStr: string]: {
    readonly track_id: string
    readonly start_ms?: number
    readonly end_ms?: number
  }
}

/* -------------------------------------------------------------------------- */
/*                               Title generator                              */
/* -------------------------------------------------------------------------- */

/**
 * POST /title — quick LLM-rephrased chat session title (3-5 words).
 * Called fire-and-forget after the first assistant reply to replace the
 * crude `deriveTitle(text)` truncation. Returns the trimmed title on
 * success, or `null` on any failure (HTTP error, network, parse). The
 * caller MUST treat a null return as "keep the current title".
 */
export async function fetchSessionTitle(
  messages: readonly ChatTurn[],
  lang: "ru" | "en",
  opts: { baseUrl?: string; appToken?: string; clientId?: string; signal?: AbortSignal } = {}
): Promise<string | null> {
  if (messages.length === 0) return null
  const baseUrl = opts.baseUrl ?? __CHAT_API_BASE_URL__
  const appToken = opts.appToken ?? __CHAT_APP_TOKEN__
  const clientId = opts.clientId ?? (await resolveClientId())

  try {
    const response = await fetch(joinUrl(baseUrl, "/title"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Device-Id": clientId,
        "X-App-Token": appToken,
        "Idempotency-Key": newIdempotencyKey(),
      },
      body: JSON.stringify({ messages, lang }),
      signal: opts.signal,
    })
    if (!response.ok) return null
    const body = (await response.json()) as { title?: unknown }
    const title = typeof body.title === "string" ? body.title.trim() : ""
    return title.length > 0 ? title : null
  } catch {
    return null
  }
}

export interface ProactiveTurnOptions {
  readonly ruleKind: "weekly_digest" | "inactivity" | "holiday"
  readonly ruleDate: string // 'YYYY-MM-DD'
  readonly ruleContext: Record<string, unknown>
}

export interface StreamChatOptions {
  readonly signal?: AbortSignal
  readonly baseUrl?: string
  readonly appToken?: string
  /** Override for tests; in production we read from IPreferences. */
  readonly clientId?: string
  /** Snapshot of recent listening + notes for personalization tools. */
  readonly userContext?: unknown
  /** When present, the backend swaps the system prompt for a
   *  rule-specific builder and `messages` is ignored. The client
   *  still sends a single placeholder turn so the existing
   *  `min_length=1` validator passes. */
  readonly proactive?: ProactiveTurnOptions
}

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stream a chat reply from the backend. Yields typed SSE events in the
 * order they arrive; consumers should treat `done` / `error` as
 * terminal and stop iterating after the first one of either.
 *
 * The implementation uses `fetch` + a `ReadableStream` reader instead
 * of EventSource because EventSource doesn't allow POST bodies or
 * custom headers — both of which our backend requires.
 */
export async function* streamChat(
  messages: readonly ChatTurn[],
  lang: "ru" | "en",
  opts: StreamChatOptions = {}
): AsyncGenerator<ChatStreamEvent, void, void> {
  const baseUrl = opts.baseUrl ?? __CHAT_API_BASE_URL__
  const appToken = opts.appToken ?? __CHAT_APP_TOKEN__
  const clientId = opts.clientId ?? (await resolveClientId())

  // Transient errors (network blip, 502/503/504 during a server redeploy)
  // get up to 3 retries with exponential backoff, but only as a *fallback*
  // — if the server set `Retry-After` we honour it instead. Non-transient
  // (400/401/403/429) bail out immediately. SSE streaming itself is NOT
  // retried — once bytes start flowing we commit to that connection.
  //
  // `Idempotency-Key` is generated per turn so a retried POST can be
  // server-side dedup'd in the future (Redis dedup is followup-PR
  // territory; today the server just logs the key). Without it, two
  // attempts after a 502 from a proxy that sat in front of a backend
  // that already started work would both bill the LLM.
  const idempotencyKey = newIdempotencyKey()
  const url = joinUrl(baseUrl, "/chat")
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Device-Id": clientId,
      "X-App-Token": appToken,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(buildRequestBody(messages, lang, opts)),
    signal: opts.signal,
  }

  let response: Response | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) return
    try {
      response = await fetch(url, requestInit)
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return
      lastErr = err
      response = null
    }
    if (response && response.ok) break
    if (response && !isTransientStatus(response.status)) break
    // Prefer the server's Retry-After (clamped). Fallback to fixed
    // exponential 250ms / 750ms / 2250ms.
    const fallback = 250 * Math.pow(3, attempt)
    const delay = response
      ? parseRetryAfterMs(response.headers.get("Retry-After"), fallback)
      : fallback
    await sleep(delay, opts.signal)
  }

  if (!response) {
    yield {
      type: "error",
      code: "network",
      message: lastErr instanceof Error ? lastErr.message : "Network error",
    }
    return
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryHeader = response.headers.get("Retry-After")
      const retryAfter = retryHeader ? Number(retryHeader) : 60
      yield {
        type: "error",
        code: "rate_limited",
        message: "Too many requests",
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : 60,
      }
      return
    }
    const text = await safeReadText(response)
    yield { type: "error", code: `http_${response.status}`, message: text }
    return
  }

  const body = response.body
  if (!body) {
    yield { type: "error", code: "no_body", message: "Empty response body" }
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex: number
      while ((separatorIndex = findEventBoundary(buffer)) !== -1) {
        const block = buffer.slice(0, separatorIndex)
        // skip the separator (2 chars for \n\n, 4 for \r\n\r\n)
        const skip = buffer.startsWith("\r\n\r\n", separatorIndex)
          ? 4
          : buffer[separatorIndex] === "\r"
            ? 4
            : 2
        buffer = buffer.slice(separatorIndex + skip)
        const event = parseSseBlock(block)
        if (!event) continue
        yield event
        if (event.type === "done" || event.type === "error") return
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return
    yield {
      type: "error",
      code: "stream",
      message: err instanceof Error ? err.message : "Stream error",
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore — reader may already be closed
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function buildRequestBody(
  messages: readonly ChatTurn[],
  lang: "ru" | "en",
  opts: StreamChatOptions
): Record<string, unknown> {
  // Wire-format messages: server's ChatMessageDto expects `aliases`
  // entries in snake_case (track_id / start_ms / end_ms). The domain
  // side uses camelCase, so we transform on the boundary.
  const wireMessages = messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.role === "assistant" && m.aliases && Object.keys(m.aliases).length > 0) {
      const wireAliases: Record<
        string,
        { track_id: string; start_ms?: number; end_ms?: number }
      > = {}
      for (const [k, v] of Object.entries(m.aliases)) {
        const entry: { track_id: string; start_ms?: number; end_ms?: number } = {
          track_id: v.trackId,
        }
        if (typeof v.startMs === "number") entry.start_ms = v.startMs
        if (typeof v.endMs === "number") entry.end_ms = v.endMs
        wireAliases[k] = entry
      }
      out.aliases = wireAliases
    }
    return out
  })
  const body: Record<string, unknown> = { messages: wireMessages, lang }
  if (opts.userContext !== undefined) body.user_context = opts.userContext
  if (opts.proactive !== undefined) {
    body.proactive = {
      rule_kind: opts.proactive.ruleKind,
      rule_date: opts.proactive.ruleDate,
      rule_context: opts.proactive.ruleContext,
    }
  }
  return body
}

async function resolveClientId(): Promise<string> {
  const app = useLectorium()
  const stored = await app.preferences.get("chat.clientId")
  if (stored) return stored
  // bootstrap.ts seeds this on first launch; if it's missing here we're
  // running pre-bootstrap (tests / debug screens). Mint a transient id so
  // the request still goes out with a valid header.
  const transient =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `transient-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return transient
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1)
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`
  return base + path
}

function isTransientStatus(code: number): boolean {
  // 502/503/504 cover redeploy and gateway downtime — retrying typically
  // succeeds once the next instance comes up. 408 (Request Timeout) is
  // intentionally NOT retried: it's almost always "the server is too
  // busy / IDLE'd out the request", and retrying compounds the load
  // without actually changing whether the server can answer.
  return code === 502 || code === 503 || code === 504
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

/** Parse a `Retry-After` header value. Returns seconds, capped to 60s
 *  so a server bug or proxy can't pin the client to a multi-hour wait. */
function parseRetryAfterMs(raw: string | null, fallbackMs: number): number {
  if (!raw) return fallbackMs
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.min(60_000, n * 1000)
  // HTTP-date form is allowed by the spec but neither our backend nor
  // the relevant proxies emit it; falling back is the right move.
  return fallbackMs
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return `HTTP ${response.status}`
  }
}

function findEventBoundary(buffer: string): number {
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
function parseSseBlock(block: string): ChatStreamEvent | null {
  let eventName: string | null = null
  const dataLines: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith(":") || line === "") continue
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""))
    }
  }
  const name = eventName ?? "delta"
  const dataRaw = dataLines.join("\n")
  let payload: Record<string, unknown> = {}
  if (dataRaw) {
    try {
      payload = JSON.parse(dataRaw) as Record<string, unknown>
    } catch {
      // Non-JSON payload — surface as a delta with the raw text so the
      // user at least sees something rather than a silent drop.
      if (name === "delta") return { type: "delta", text: dataRaw }
      return null
    }
  }

  switch (name) {
    case "delta":
      return { type: "delta", text: typeof payload.text === "string" ? payload.text : "" }
    case "tool_start":
      return { type: "tool_start" }
    case "tool":
      return { type: "tool" }
    case "done":
      return { type: "done" }
    case "action": {
      const ap = parseActionPayload(payload)
      return ap ? { type: "action", payload: ap } : null
    }
    case "outline": {
      const op = parseOutlinePayload(payload)
      return op ? { type: "outline", payload: op } : null
    }
    case "aliases": {
      const map = parseAliasMap(payload.map)
      return map ? { type: "aliases", map } : null
    }
    case "error":
      return {
        type: "error",
        code: typeof payload.code === "string" ? payload.code : "unknown",
        message: typeof payload.message === "string" ? payload.message : "",
        retryAfter:
          typeof payload.retry_after === "number"
            ? payload.retry_after
            : typeof payload.retryAfter === "number"
              ? payload.retryAfter
              : undefined,
      }
    default:
      // Unknown event name. The server may have shipped ahead of the
      // client (new event type added in a later release); log it so a
      // silent feature-drop shows up in dev consoles and crash logs,
      // and return null so the rest of the stream still flows.

      console.warn("[chat] unknown sse event:", name)
      return null
  }
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

function parseOutlinePayload(p: Record<string, unknown>): OutlinePayload | null {
  const trackId = typeof p.track_id === "string" ? p.track_id : null
  const itemsRaw = Array.isArray(p.items) ? p.items : null
  if (!trackId || !itemsRaw) return null
  const items: OutlineItemPayload[] = []
  for (const it of itemsRaw) {
    if (it && typeof it === "object") {
      const obj = it as Record<string, unknown>
      const startMs = typeof obj.start_ms === "number" ? obj.start_ms : null
      const title = typeof obj.title === "string" ? obj.title.trim() : ""
      if (startMs !== null && title) items.push({ startMs, title })
    }
  }
  if (items.length === 0) return null
  return { trackId, items }
}

function parseActionPayload(p: Record<string, unknown>): ActionPayload | null {
  const kind = typeof p.kind === "string" ? p.kind : ""
  const id = typeof p.id === "string" ? p.id : ""
  if (!kind || !id) return null
  if (kind === "create_playlist") {
    const name = typeof p.name === "string" ? p.name : ""
    const trackIdsRaw = Array.isArray(p.track_ids) ? p.track_ids : []
    const trackIds = trackIdsRaw.filter((x): x is string => typeof x === "string")
    if (!name || trackIds.length === 0) return null
    return { kind: "create_playlist", id, name, trackIds }
  }
  if (kind === "share_pdf") {
    const itemsRaw = Array.isArray(p.items) ? p.items : []
    const items: SharePdfItemPayload[] = []
    for (const raw of itemsRaw) {
      if (!raw || typeof raw !== "object") continue
      const it = raw as Record<string, unknown>
      const trackId = typeof it.track_id === "string" ? it.track_id : ""
      const pdfUrl = typeof it.pdf_url === "string" ? it.pdf_url : ""
      if (!trackId || !pdfUrl) continue
      items.push({
        trackId,
        lang: typeof it.lang === "string" ? it.lang : "",
        title: typeof it.title === "string" ? it.title : trackId,
        author: typeof it.author === "string" ? it.author : null,
        date: typeof it.date === "string" ? it.date : null,
        pdfUrl,
      })
    }
    if (items.length === 0) return null
    return { kind: "share_pdf", id, items }
  }
  if (kind === "enable_daily_reminder") {
    const time = typeof p.time === "string" && /^\d{1,2}:\d{2}$/.test(p.time) ? p.time : "07:00"
    return { kind: "enable_daily_reminder", id, time }
  }
  if (kind === "configure_smart_library") {
    const f =
      p.filters && typeof p.filters === "object" ? (p.filters as Record<string, unknown>) : {}
    const pickStringArray = (v: unknown): readonly string[] | undefined => {
      if (!Array.isArray(v)) return undefined
      const xs = v.filter((x): x is string => typeof x === "string")
      return xs.length > 0 ? xs : undefined
    }
    return {
      kind: "configure_smart_library",
      id,
      filters: {
        authorIds: pickStringArray(f.author_ids),
        tagIds: pickStringArray(f.tag_ids),
        sourceIds: pickStringArray(f.source_ids),
        locationIds: pickStringArray(f.location_ids),
        languageCodes: pickStringArray(f.language_codes),
      },
    }
  }
  if (kind === "upgrade_to_pro") {
    const reason = typeof p.reason === "string" && p.reason.length > 0 ? p.reason : "generic"
    return { kind: "upgrade_to_pro", id, reason }
  }
  return null
}
