import { useShruti } from "@shruti/shruti.js"

/* -------------------------------------------------------------------------- */
/*                              Wire-protocol types                           */
/* -------------------------------------------------------------------------- */

export type ChatRole = "user" | "assistant"

export interface ChatTurn {
  readonly role: ChatRole
  readonly content: string
}

export interface OutlineItemPayload {
  readonly startMs: number
  readonly title: string
}

export interface OutlinePayload {
  readonly trackId: string
  readonly items: readonly OutlineItemPayload[]
}

export type ActionPayload =
  | {
      readonly kind: "create_playlist"
      readonly id: string
      readonly name: string
      readonly trackIds: readonly string[]
      readonly rationale: string
    }
  | {
      readonly kind: "save_note"
      readonly id: string
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      readonly text: string
      readonly suggestedCaption: string
    }

export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "tool"
      readonly name: string
      readonly durationMs?: number
      readonly resultCount?: number
    }
  | { readonly type: "action"; readonly payload: ActionPayload }
  | { readonly type: "outline"; readonly payload: OutlinePayload }
  | {
      readonly type: "done"
      readonly requestId?: string
      readonly totalTokens?: number
      readonly toolCalls?: number
    }
  | {
      readonly type: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
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

export interface StreamChatOptions {
  readonly signal?: AbortSignal
  readonly baseUrl?: string
  readonly appToken?: string
  /** Override for tests; in production we read from IPreferences. */
  readonly clientId?: string
  /** Snapshot of recent listening + notes for personalization tools. */
  readonly userContext?: unknown
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
  // get up to 3 retries with exponential backoff. Non-transient (400/401/403/
  // 429) bail out immediately. SSE streaming itself is NOT retried — once
  // bytes start flowing we commit to that connection.
  const url = joinUrl(baseUrl, "/chat")
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Device-Id": clientId,
      "X-App-Token": appToken,
    },
    body: JSON.stringify(
      opts.userContext !== undefined
        ? { messages, lang, user_context: opts.userContext }
        : { messages, lang }
    ),
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
    // back off: 250ms, 750ms, 2250ms
    const delay = 250 * Math.pow(3, attempt)
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

async function resolveClientId(): Promise<string> {
  const app = useShruti()
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
  // 502/503/504 cover redeploy downtime; 408 = client/server idle timeout.
  return code === 408 || code === 502 || code === 503 || code === 504
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
    case "tool":
      return {
        type: "tool",
        name: typeof payload.name === "string" ? payload.name : "unknown",
        durationMs:
          typeof payload.duration_ms === "number"
            ? payload.duration_ms
            : typeof payload.durationMs === "number"
              ? payload.durationMs
              : undefined,
        resultCount:
          typeof payload.result_count === "number"
            ? payload.result_count
            : typeof payload.resultCount === "number"
              ? payload.resultCount
              : undefined,
      }
    case "done":
      return {
        type: "done",
        requestId:
          typeof payload.request_id === "string"
            ? payload.request_id
            : typeof payload.requestId === "string"
              ? payload.requestId
              : undefined,
        totalTokens:
          typeof payload.total_tokens === "number"
            ? payload.total_tokens
            : typeof payload.totalTokens === "number"
              ? payload.totalTokens
              : undefined,
        toolCalls:
          typeof payload.tool_calls === "number"
            ? payload.tool_calls
            : typeof payload.toolCalls === "number"
              ? payload.toolCalls
              : undefined,
      }
    case "action": {
      const ap = parseActionPayload(payload)
      return ap ? { type: "action", payload: ap } : null
    }
    case "outline": {
      const op = parseOutlinePayload(payload)
      return op ? { type: "outline", payload: op } : null
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
      return null
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
  if (kind === "create_playlist") {
    const name = typeof p.name === "string" ? p.name : ""
    const trackIdsRaw = Array.isArray(p.track_ids) ? p.track_ids : []
    const trackIds = trackIdsRaw.filter((x): x is string => typeof x === "string")
    if (!name || trackIds.length === 0) return null
    return {
      kind: "create_playlist",
      id,
      name,
      trackIds,
      rationale: typeof p.rationale === "string" ? p.rationale : "",
    }
  }
  if (kind === "save_note") {
    const trackId = typeof p.track_id === "string" ? p.track_id : ""
    const text = typeof p.text === "string" ? p.text : ""
    if (!trackId || !text) return null
    return {
      kind: "save_note",
      id,
      trackId,
      startMs: typeof p.start_ms === "number" ? p.start_ms : 0,
      endMs: typeof p.end_ms === "number" ? p.end_ms : 0,
      text,
      suggestedCaption: typeof p.suggested_caption === "string" ? p.suggested_caption : "",
    }
  }
  return null
}
