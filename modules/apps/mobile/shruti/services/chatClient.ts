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

/**
 * v1 SSE protocol: every `action` event is `{kind, id, payload: {...}}`.
 * The discriminator is `kind`; payload shape depends on it. Splitting
 * the static fields (kind, id) from the kind-specific body simplifies
 * routing on the client — one switch on `kind`, kind-specific reading
 * pulled from `payload`.
 *
 * Auto-render kinds (card, outline, verse) pair with an inline
 * marker in delta text — the action event arrives first and stashes
 * the payload; the marker triggers render. Interactive kinds
 * (share_pdf, enable_daily_reminder, …) render a standalone card
 * with a confirm button — no inline marker.
 */
export type ActionPayload =
  | {
      readonly kind: "share_pdf"
      readonly id: string
      readonly payload: {
        readonly items: readonly SharePdfItemPayload[]
      }
    }
  | {
      readonly kind: "enable_daily_reminder"
      readonly id: string
      readonly payload: {
        /** `'HH:mm'` 24h local time. */
        readonly time: string
      }
    }
  | {
      readonly kind: "configure_smart_library"
      readonly id: string
      readonly payload: {
        readonly filters: {
          readonly authorIds?: readonly string[]
          readonly tagIds?: readonly string[]
          readonly sourceIds?: readonly string[]
          readonly locationIds?: readonly string[]
          readonly languageCodes?: readonly string[]
        }
      }
    }
  | {
      readonly kind: "upgrade_to_pro"
      readonly id: string
      readonly payload: { readonly reason: string }
    }
  // Auto-render widgets paired with inline markers in delta text.
  | {
      readonly kind: "outline"
      readonly id: string
      readonly payload: OutlinePayload
    }
  | {
      readonly kind: "verse"
      readonly id: string
      readonly payload: VersePayload
    }

/** Discriminator for `research_source` events — what kind of corpus
 *  item the research pipeline is inspecting right now. */
export type ResearchSourceKind = "verse" | "lecture_chunk" | "library_doc"

/**
 * Decoded SSE events — v1 protocol (9 types). Negotiated via the
 * `X-Chat-Protocol-Version: 1` request header; server rejects with
 * 426 if absent. See backend `agent/events.py` for the contract.
 *
 * - `delta`      streaming text fragment
 * - `tool_start` / `tool_end`  tool-call lifecycle (UI thinking pill)
 * - `status`     i18n status label (key + optional params)
 * - `action`     widget payload — auto-render (paired with marker in
 *                delta text) or interactive (standalone card). The
 *                action event MUST arrive BEFORE its paired marker.
 * - `research_question` / `research_source` — live progress events
 *                from the research pipeline (sub-queries it generated,
 *                sources it's inspecting). Additive in protocol v1:
 *                old clients ignore them via the parser default branch.
 *                Wire `kind` field renamed to `sourceKind` in the
 *                decoded shape to avoid clashing with the `kind`
 *                discriminator used by `ActionPayload`.
 * - `done`       terminal; carries alias map for next-turn round-trip
 * - `error`      terminal failure
 */
export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly name?: string }
  | { readonly type: "tool_end"; readonly name?: string }
  | {
      readonly type: "status"
      readonly key: string
      readonly params?: Readonly<Record<string, string | number>>
    }
  | { readonly type: "action"; readonly payload: ActionPayload }
  | { readonly type: "research_question"; readonly question: string }
  | {
      readonly type: "research_source"
      readonly sourceKind: ResearchSourceKind
      readonly id: string
      readonly label: string
    }
  | { readonly type: "done"; readonly aliases?: AliasMapPayload }
  | {
      readonly type: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
    }

/** Wire shape of a verse body — carried by an `action` event with
 *  `kind: "verse"` per SSE v1. `translation` is keyed by ISO-639
 *  language code (`ru`, `en`, …); rendering picks the entry matching
 *  the user's current locale and falls back to any available one. */
export interface VersePayload {
  readonly source_id: string
  readonly tokens: string
  readonly addr_label: string
  readonly sanskrit: string
  readonly transliteration: string
  readonly translation: { readonly [lang: string]: string }
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
  opts: {
    baseUrl?: string
    appToken?: string
    getAccessToken?: () => Promise<string | null>
    signal?: AbortSignal
  } = {}
): Promise<string | null> {
  if (messages.length === 0) return null
  const baseUrl = opts.baseUrl ?? __CHAT_API_BASE_URL__
  const appToken = opts.appToken ?? __CHAT_APP_TOKEN__

  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /title is fire-and-forget; no recovery surface if auth is unrecoverable.
    return null
  }

  try {
    const response = await fetch(joinUrl(baseUrl, "/title"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
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

/* -------------------------------------------------------------------------- */
/*                          Suggested-questions generator                     */
/* -------------------------------------------------------------------------- */

/** Wire shape for the `/questions` request body. Server expects
 *  camelCase for `focus.*` fields (Pydantic alias = trackId / startMs /
 *  endMs / trackTitle / authorName). `lang` is the UI language. */
export interface QuestionsFocusInput {
  readonly trackId: string
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  readonly sourceKey?: string
  readonly trackTitle?: string
  readonly authorName?: string
  readonly date?: string
  readonly location?: string
}

/**
 * POST /questions — 3-4 short suggestion chips for the focus fragment
 * the user just dropped into the chat. Fire-and-forget on the client
 * side: any error path (network, HTTP non-2xx, parse failure, server
 * returned []) collapses to an empty list, which the UI renders as
 * "no chips" without a toast. The caller MUST treat the empty result
 * as graceful degradation, not as a hard failure.
 */
export async function fetchSuggestedQuestions(
  focus: QuestionsFocusInput,
  lang: "ru" | "en",
  opts: {
    baseUrl?: string
    appToken?: string
    getAccessToken?: () => Promise<string | null>
    signal?: AbortSignal
  } = {}
): Promise<readonly string[]> {
  const baseUrl = opts.baseUrl ?? __CHAT_API_BASE_URL__
  const appToken = opts.appToken ?? __CHAT_APP_TOKEN__

  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /questions is fire-and-forget; empty chips on auth failure is the
    // graceful path (caller renders "no chips" without a toast).
    return []
  }

  try {
    const response = await fetch(joinUrl(baseUrl, "/questions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-App-Token": appToken,
        "Idempotency-Key": newIdempotencyKey(),
      },
      body: JSON.stringify({ focus, lang }),
      signal: opts.signal,
    })
    if (!response.ok) return []
    const body = (await response.json()) as { questions?: unknown }
    if (!Array.isArray(body.questions)) return []
    return body.questions
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
  } catch {
    return []
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
  /** Test override for the JWT provider. In production the module-level
   *  provider (set via setAccessTokenProvider) is used. */
  readonly getAccessToken?: () => Promise<string | null>
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
  const token = await resolveAccessToken(opts.getAccessToken)

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
      Authorization: `Bearer ${token}`,
      "X-App-Token": appToken,
      "X-Chat-Protocol-Version": "1",
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
      const wireAliases: Record<string, { track_id: string; start_ms?: number; end_ms?: number }> =
        {}
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

/**
 * Token provider injected at app boot (shruti.ts wires `useShruti().auth.getAccessToken`
 * into here). Pulled out as a module-level slot so the dozens of call-sites
 * for streamChat / fetchSessionTitle / fetchSuggestedQuestions don't each
 * have to thread an explicit `getAccessToken` argument through.
 *
 * Tests can override via the `getAccessToken` option on each function.
 */
type AccessTokenProvider = () => Promise<string | null>
let _accessTokenProvider: AccessTokenProvider | null = null

export function setAccessTokenProvider(provider: AccessTokenProvider | null): void {
  _accessTokenProvider = provider
}

async function resolveAccessToken(override?: AccessTokenProvider): Promise<string> {
  const provider = override ?? _accessTokenProvider
  if (!provider) {
    throw new Error(
      "chatClient: no access token provider — call setAccessTokenProvider() during app bootstrap"
    )
  }
  const token = await provider()
  if (!token) {
    throw new Error("chatClient: auth.getAccessToken returned null (session unrecoverable)")
  }
  return token
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
      // Non-JSON payload. For `delta` we surface the raw text so the
      // user still sees something — text-only delta is a documented
      // fallback in the wire protocol. For any other event name a
      // malformed payload is a server bug; log so it doesn't disappear
      // silently in production.
      if (name === "delta") return { type: "delta", text: dataRaw }
      console.warn("chatClient: malformed SSE event payload", {
        event: name,
        bytes: dataRaw.length,
      })
      return null
    }
  }

  switch (name) {
    case "delta":
      return { type: "delta", text: typeof payload.text === "string" ? payload.text : "" }
    case "tool_start":
      return {
        type: "tool_start",
        name: typeof payload.name === "string" ? payload.name : undefined,
      }
    case "tool_end":
      return {
        type: "tool_end",
        name: typeof payload.name === "string" ? payload.name : undefined,
      }
    case "status":
      return {
        type: "status",
        key: typeof payload.key === "string" ? payload.key : "",
        params: parseStatusParams(payload.params),
      }
    case "done": {
      const aliases = parseAliasMap(payload.aliases)
      return aliases ? { type: "done", aliases } : { type: "done" }
    }
    case "action": {
      const ap = parseActionPayload(payload)
      return ap ? { type: "action", payload: ap } : null
    }
    case "research_question": {
      const question = typeof payload.question === "string" ? payload.question.trim() : ""
      if (!question) return null
      return { type: "research_question", question }
    }
    case "research_source": {
      // Wire field is `kind`; we rename to `sourceKind` on the decoded
      // shape so it doesn't collide with the `kind` discriminator on
      // ActionPayload.
      const wireKind = typeof payload.kind === "string" ? payload.kind : ""
      if (wireKind !== "verse" && wireKind !== "lecture_chunk" && wireKind !== "library_doc") {
        return null
      }
      const id = typeof payload.id === "string" ? payload.id.trim() : ""
      const label = typeof payload.label === "string" ? payload.label.trim() : ""
      if (!id) return null
      return {
        type: "research_source",
        sourceKind: wireKind as ResearchSourceKind,
        id,
        label,
      }
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
      console.warn("[chat] unknown sse event:", name)
      return null
  }
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

function parseVersePayload(p: Record<string, unknown>): VersePayload | null {
  const sourceId = typeof p.source_id === "string" ? p.source_id : ""
  const tokens = typeof p.tokens === "string" ? p.tokens : ""
  if (!sourceId || !tokens) return null
  const addrLabel = typeof p.addr_label === "string" ? p.addr_label : ""
  const sanskrit = typeof p.sanskrit === "string" ? p.sanskrit : ""
  const transliteration = typeof p.transliteration === "string" ? p.transliteration : ""
  const translation: Record<string, string> = {}
  if (p.translation && typeof p.translation === "object" && !Array.isArray(p.translation)) {
    for (const [lang, text] of Object.entries(p.translation as Record<string, unknown>)) {
      if (typeof text === "string" && text) translation[lang] = text
    }
  }
  return {
    source_id: sourceId,
    tokens,
    addr_label: addrLabel,
    sanskrit,
    transliteration,
    translation,
  }
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
  // v1 wire shape: kind-specific body lives under `payload`. Older
  // event shapes (flat `{kind, id, name, ...}`) are rejected — the
  // protocol handshake guarantees the server speaks v1, so any
  // straggling flat-shape event is a server bug, not a forward-compat
  // case we need to humor.
  const body =
    p.payload && typeof p.payload === "object" && !Array.isArray(p.payload)
      ? (p.payload as Record<string, unknown>)
      : null
  if (!body) return null

  if (kind === "share_pdf") {
    const itemsRaw = Array.isArray(body.items) ? body.items : []
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
    return { kind: "share_pdf", id, payload: { items } }
  }
  if (kind === "enable_daily_reminder") {
    const time =
      typeof body.time === "string" && /^\d{1,2}:\d{2}$/.test(body.time) ? body.time : "07:00"
    return { kind: "enable_daily_reminder", id, payload: { time } }
  }
  if (kind === "configure_smart_library") {
    const f =
      body.filters && typeof body.filters === "object"
        ? (body.filters as Record<string, unknown>)
        : {}
    const pickStringArray = (v: unknown): readonly string[] | undefined => {
      if (!Array.isArray(v)) return undefined
      const xs = v.filter((x): x is string => typeof x === "string")
      return xs.length > 0 ? xs : undefined
    }
    return {
      kind: "configure_smart_library",
      id,
      payload: {
        filters: {
          authorIds: pickStringArray(f.author_ids),
          tagIds: pickStringArray(f.tag_ids),
          sourceIds: pickStringArray(f.source_ids),
          locationIds: pickStringArray(f.location_ids),
          languageCodes: pickStringArray(f.language_codes),
        },
      },
    }
  }
  if (kind === "upgrade_to_pro") {
    const reason =
      typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "generic"
    return { kind: "upgrade_to_pro", id, payload: { reason } }
  }
  if (kind === "outline") {
    const op = parseOutlinePayload(body)
    return op ? { kind: "outline", id, payload: op } : null
  }
  if (kind === "verse") {
    const vp = parseVersePayload(body)
    return vp ? { kind: "verse", id, payload: vp } : null
  }
  return null
}
