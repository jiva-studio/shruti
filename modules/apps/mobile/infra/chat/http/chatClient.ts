import {
  attributeValues,
  BackendUnavailableError,
  ProtocolVersionMismatchError,
} from "@lib/domain/chatMessage.js"

// Re-export so the mobile store + tests can import either from the
// domain barrel or directly off the chat HTTP adapter — keeps the
// import path short at call-sites that already pull other types from
// this module.
export { BackendUnavailableError, ProtocolVersionMismatchError }

/* -------------------------------------------------------------------------- */
/*                              Wire-protocol types                           */
/* -------------------------------------------------------------------------- */

// The SSE wire protocol is owned by `@lib/contracts` (the shared kernel) so a
// server protocol change is edited in ONE place. Imported here under shorter
// local names for the parsers below; decoded payloads stay snake_case
// (verbatim from the wire), and the `runChatTurn` use-case is the single
// boundary that maps them to the camelCase domain shapes — `media` included.
import type {
  ChatTurn,
  ChatAttribute,
  ChatAttributes,
  ResearchSourceKind,
  ChatStreamEvent,
  ChatActionPayload as ActionPayload,
  ChatOutlinePayload as OutlinePayload,
  ChatSharePdfRefPayload as SharePdfRefPayload,
  ChatSharePdfItemPayload as SharePdfItemPayload,
  ChatVersePayloadWire as VersePayload,
  ChatCiteTranscriptPayloadWire as CiteTranscriptPayload,
  ChatCommentaryPayloadWire as CommentaryPayload,
  ChatChapterPayloadWire as ChapterPayload,
  ChatMediaPayloadWire as MediaPayload,
} from "@lib/contracts"

/** One outline list-item. `@lib/contracts` inlines this inside
 *  `ChatOutlinePayload.items`; named here for the parser's local use. */
interface OutlineItemPayload {
  readonly startMs: number
  readonly title: string
}

/** Decoded alias map — same shape as the wire `done.aliases`. Keys are
 *  integer aliases serialised as strings; start/end ms only on cite-level
 *  chunk aliases. The use-case maps it to camelCase `ChatAliasEntry`. */
interface AliasMapPayload {
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
  lang: string,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<string | null> {
  if (messages.length === 0) return null

  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /title is fire-and-forget; no recovery surface if auth is unrecoverable.
    return null
  }

  try {
    const response = await opts.request("/title", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
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
  lang: string,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<readonly string[]> {
  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /questions is fire-and-forget; empty chips on auth failure is the
    // graceful path (caller renders "no chips" without a toast).
    return []
  }

  try {
    const response = await opts.request("/questions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
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

/* -------------------------------------------------------------------------- */
/*                          POST /chat/feedback client                        */
/* -------------------------------------------------------------------------- */

export type FeedbackValue = "up" | "down"
export type FeedbackCategory =
  | "off_topic"
  | "no_results"
  | "bad_citations"
  | "wrong_language"
  | "factually_wrong"
  | "other"

export interface FeedbackPayload {
  /** Local `ChatMessage.id` of the assistant message (UUIDv4). Sent on
   *  the wire as the hyphenless 32-hex form, which is the same value
   *  that was used as the Langfuse trace_id when the turn streamed. */
  readonly messageId: string
  readonly value: FeedbackValue
  /** Only meaningful when `value === "down"`. Server silently ignores
   *  it on `up` per state-machine contract. */
  readonly category?: FeedbackCategory
  /** Optional free-form text (≤500 chars). Server truncates to 500;
   *  we don't enforce the limit here so a copy-paste of a long
   *  paragraph still uploads (just truncated). */
  readonly comment?: string
}

/**
 * Persist the user's thumbs-up/down (with optional category + comment)
 * to the backend. Throws on non-2xx HTTP or network failure — the
 * caller is responsible for revert + retry.
 */
export async function postFeedback(
  payload: FeedbackPayload,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<void> {
  const token = await resolveAccessToken(opts.getAccessToken)

  const traceId = payload.messageId.replace(/-/g, "").toLowerCase()
  const body: Record<string, unknown> = {
    trace_id: traceId,
    value: payload.value,
  }
  if (payload.category) body.category = payload.category
  if (payload.comment) body.comment = payload.comment

  const response = await opts.request("/chat/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`feedback failed: ${response.status} ${text || response.statusText}`)
  }
}

/** A single buffered SSE frame as stored by the server's turn buffer. */
export interface StoredTurnFrame {
  readonly event: string
  readonly data: string
}

/** A turn fetched from the server's turn store. `running` ⇒ still
 *  generating (keep polling); `done` / `error` ⇒ replay `events` to
 *  rebuild the message. */
export interface BufferedTurn {
  readonly state: "running" | "done" | "error"
  readonly events: readonly StoredTurnFrame[]
}

/**
 * Poll a turn's buffered result by the assistant message id — its
 * hyphenless form is the server trace id (same derivation as feedback).
 * Returns null on 404: the turn was never received, its 24h buffer
 * expired, or it isn't ours. Used by the resume flow when the client
 * reconnects after a background / app-kill that dropped the live stream.
 */
export async function getTurn(
  messageId: string,
  opts: { request: ChatRequest; getAccessToken: AccessTokenProvider; signal?: AbortSignal }
): Promise<BufferedTurn | null> {
  const token = await resolveAccessToken(opts.getAccessToken)
  const traceId = messageId.replace(/-/g, "").toLowerCase()
  const response = await opts.request(`/chat/turn/${traceId}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: opts.signal,
  })
  if (response.status === 404) return null
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`getTurn failed: ${response.status} ${text || response.statusText}`)
  }
  const json = (await response.json()) as { state?: unknown; events?: unknown }
  const state: BufferedTurn["state"] =
    json.state === "done" || json.state === "error" ? json.state : "running"
  const events: StoredTurnFrame[] = Array.isArray(json.events)
    ? (json.events as unknown[]).filter(
        (e): e is StoredTurnFrame =>
          !!e &&
          typeof (e as StoredTurnFrame).event === "string" &&
          typeof (e as StoredTurnFrame).data === "string"
      )
    : []
  return { state, events }
}

/**
 * Explicit Stop for a turn — really cancel it server-side (vs a passive
 * disconnect, which lets it finish and buffer). Best-effort: a failure
 * just means the turn may run to completion.
 */
export async function cancelTurn(
  messageId: string,
  opts: { request: ChatRequest; getAccessToken: AccessTokenProvider; signal?: AbortSignal }
): Promise<void> {
  try {
    const token = await resolveAccessToken(opts.getAccessToken)
    const traceId = messageId.replace(/-/g, "").toLowerCase()
    await opts.request(`/chat/turn/${traceId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: opts.signal,
    })
  } catch {
    // Best-effort — the local abort already stopped the UI; the server
    // turn lapses on its own if this never lands.
  }
}

/**
 * Parse one buffered SSE frame ({event, data}) back into a typed
 * ChatStreamEvent by reusing the live-stream block parser — a replayed
 * turn folds through the EXACT same logic as the live stream, so no
 * second parser can drift from the wire contract.
 */
export function parseStoredFrame(frame: StoredTurnFrame): ChatStreamEvent | null {
  return parseSseBlock(`event: ${frame.event}\ndata: ${frame.data}`)
}

export interface ProactiveTurnOptions {
  readonly ruleKind: "weekly_digest" | "inactivity" | "holiday"
  readonly ruleDate: string // 'YYYY-MM-DD'
  readonly ruleContext: Record<string, unknown>
}

/**
 * Request-init for {@link streamChat}. Carries the transport-level
 * concerns (auth, base URL, app token, abort signal) plus the per-turn
 * options (proactive context, idempotency, etc.). Distinct from the
 * port's `StreamChatOptions` (which is the public surface a use case
 * sees) — the adapter merges port opts with its DI'd `getAccessToken`
 * before calling this.
 */
export interface StreamChatRequestInit {
  readonly signal?: AbortSignal
  /** HTTP call to the chat service. Path is relative; the implementation
   *  prepends the active server's chat base URL and handles failover to
   *  other servers on transient errors (see `createFailoverClient`). */
  readonly request: ChatRequest
  /** JWT provider — typically `app.auth.getAccessToken`, injected
   *  through the adapter's constructor. Required: the chatClient
   *  doesn't hold any module-level fallback. */
  readonly getAccessToken: AccessTokenProvider
  /** Snapshot of recent listening + notes for personalization tools. */
  readonly userContext?: unknown
  /** When present, the backend swaps the system prompt for a
   *  rule-specific builder and `messages` is ignored. The client
   *  still sends a single placeholder turn so the existing
   *  `min_length=1` validator passes. */
  readonly proactive?: ProactiveTurnOptions
  /** Local chat_sessions.id — groups this turn with sibling turns of
   *  the same conversation in Langfuse Sessions. */
  readonly sessionId?: string
  /** Human-readable chat session title (from chat_sessions.title).
   *  Surfaced as metadata on the trace so the Langfuse Sessions view
   *  shows something more useful than a raw UUID. */
  readonly sessionTitle?: string
  /** Pre-minted assistant `ChatMessage.id` (UUIDv4). Sent in
   *  `X-Trace-Id` header as the hyphenless 32-hex form so the server
   *  uses it as the Langfuse trace_id. Same value is the local DB
   *  primary key of the assistant row, which makes message identity
   *  and trace identity one and the same — a later /chat/feedback
   *  POST referencing this id lands the score on the right trace. */
  readonly assistantMessageId?: string
  /** Forwarded as the wire `translate_citations` flag. When true the
   *  server may machine-translate verbatim citations into `lang`. */
  readonly translateCitations?: boolean
  /** Forwarded as the wire `capabilities` map — what this client can
   *  render. The server adapts its output accordingly (e.g.
   *  `{ commentary_card: true }` ships purports as card payloads instead
   *  of inline blockquotes). Additive; omitted ⇒ legacy rendering. */
  readonly capabilities?: Readonly<Record<string, boolean>>
}

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

/**
 * Give up on an SSE socket that hasn't delivered a single byte for this long.
 *
 * The chat service pings every 15s (`ping=15` on its `EventSourceResponse`),
 * and those keepalive comment frames count as bytes even though the parser
 * drops them — so on a healthy connection the gap between reads is 15s at
 * worst, whatever the model is doing. Three missed heartbeats is the shortest
 * window a late ping or a slow radio can't trip; anything longer just keeps
 * the spinner up. A half-open socket (NAT dropped the flow, radio changed)
 * never delivers `done` and never errors, so without this the read below waits
 * forever on a connection that is already dead.
 */
export const SSE_STALL_TIMEOUT_MS = 45_000

/** A read that outlived {@link SSE_STALL_TIMEOUT_MS}. Named so the stream's
 *  catch can't mistake it for the caller's abort. */
class SseStallError extends Error {
  readonly kind = "sse_stall"
  constructor(timeoutMs: number) {
    super(`SSE stalled: no data for ${timeoutMs}ms`)
    this.name = "SseStallError"
  }
}

/**
 * One `reader.read()` under a stall deadline. The timer is armed per read and
 * cleared on every resolution, so ANY byte — a delta, a keepalive comment —
 * restarts the window: that is the last-byte clock, without having to thread
 * one through the parser.
 */
async function readWithStallTimeout<T>(
  reader: { read: () => Promise<T> },
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SseStallError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Give up on a `POST /chat` that has not produced RESPONSE HEADERS this long.
 *
 * {@link SSE_STALL_TIMEOUT_MS} only starts once we hold a `Response` — an edge
 * that completes the TCP/TLS handshake and then never writes a status line
 * leaves `fetch` pending forever (it has no default timeout, and the failover
 * client adds none). The chat service flushes SSE headers before the model
 * runs, so headers are a fast handshake even on a slow answer; the budget here
 * only has to cover the request upload (up to 20 turns of history) on a poor
 * radio. Shorter than the stall window on purpose — nothing is streaming yet,
 * so there is nothing to lose by re-dialling.
 */
export const CHAT_HEADERS_TIMEOUT_MS = 30_000

/** A `POST /chat` that outlived {@link CHAT_HEADERS_TIMEOUT_MS} before sending
 *  headers. Distinct from an `AbortError` so the retry loop treats it as a
 *  transient network failure (its own `lastErr`) rather than the caller's
 *  Stop. */
class ChatHeadersTimeoutError extends Error {
  readonly kind = "headers_timeout"
  constructor(timeoutMs: number) {
    super(`POST /chat sent no response headers for ${timeoutMs}ms`)
    this.name = "ChatHeadersTimeoutError"
  }
}

/**
 * One `POST /chat` attempt under a header deadline.
 *
 * The deadline ABORTS the request rather than racing it — a bare
 * `Promise.race` would resolve the caller while the socket stayed open,
 * leaking a connection per attempt. So each attempt gets its own controller,
 * bridged to the caller's signal (Stop still kills the request, and still
 * kills the body read afterwards: the bridge is deliberately left attached
 * for the lifetime of the response). The timer is cleared the moment headers
 * land, so a long-running answer streams unimpeded.
 */
async function requestWithHeadersTimeout(
  request: ChatRequest,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await request("/chat", { ...init, signal: controller.signal })
  } catch (err) {
    // Our own deadline fired: the abort surfaces as an AbortError, which the
    // caller would otherwise read as the user pressing Stop.
    if (timedOut && !callerSignal?.aborted) throw new ChatHeadersTimeoutError(timeoutMs)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `Retry-After` as a positive number of seconds, or `undefined` when the
 * header is absent or is not a delay-seconds value.
 *
 * `undefined` is the point. This used to fall back to a hard-coded 60, which
 * left the store unable to tell a real `Retry-After` from a number the
 * transport had invented — so the invented one could (and did) outrank the
 * server's own `resets_at_epoch`, locking the composer for 60 s against a 12 s
 * reset. Absence is reported as absence; deciding what to do without one is
 * the store's business, not the transport's.
 *
 * The RFC's HTTP-date form is deliberately not accepted here: reading it needs
 * a clock, and the whole purpose of this value is to be clock-free. It falls
 * through to {@link serverMeasuredWaitSeconds}, which resolves an absolute
 * instant properly.
 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * The wait implied by `resets_at_epoch`, measured against the response's own
 * `Date` header — an absolute server instant minus an absolute server instant,
 * i.e. two readings of the same clock. The difference is therefore a pure
 * server-side DURATION: whatever the device believes the time to be cancels
 * out, because the device's clock never enters the subtraction.
 *
 * That is what makes it safe for the store to count down from its own `now`.
 * Converting `resets_at_epoch` with `Date.now()` instead would put the device
 * clock back into the arithmetic and reproduce the very skew this avoids — a
 * device a day slow would compute a day-long wait from a 12-second reset.
 */
function serverMeasuredWaitSeconds(
  dateHeader: string | null,
  resetsAtEpoch: number | undefined
): number | undefined {
  if (dateHeader === null || resetsAtEpoch === undefined || resetsAtEpoch <= 0) return undefined
  const serverNowMs = Date.parse(dateHeader)
  if (!Number.isFinite(serverNowMs)) return undefined
  const waitSeconds = resetsAtEpoch - Math.floor(serverNowMs / 1000)
  return waitSeconds > 0 ? waitSeconds : undefined
}

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
  lang: string,
  opts: StreamChatRequestInit
): AsyncGenerator<ChatStreamEvent, void, void> {
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${token}`,
    "X-Chat-Protocol-Version": "1",
    "Idempotency-Key": idempotencyKey,
  }
  // Use the assistant message id (UUIDv4) as the Langfuse trace id —
  // hyphenless form matches OTel's 32-hex requirement. Skipped when
  // the caller didn't pre-mint one (only happens in legacy callers or
  // tests); the server falls back to its own id in that case.
  if (opts.assistantMessageId) {
    const traceId = opts.assistantMessageId.replace(/-/g, "").toLowerCase()
    if (/^[0-9a-f]{32}$/.test(traceId)) {
      headers["X-Trace-Id"] = traceId
    }
  }
  const requestInit: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(messages, lang, opts)),
    signal: opts.signal,
  }

  let response: Response | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) return
    try {
      response = await requestWithHeadersTimeout(
        opts.request,
        requestInit,
        opts.signal,
        CHAT_HEADERS_TIMEOUT_MS
      )
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
    // 426 — `X-Chat-Protocol-Version` doesn't match anything the
    // server supports. The mismatch is structural (no retry will help
    // until the app updates), so throw a typed error instead of
    // funneling it into the SSE error event stream. The store catches
    // and surfaces a "please update" toast with a store-link CTA.
    if (response.status === 426) {
      let supported: number[] | undefined
      let received: number | undefined
      try {
        const json = (await response.clone().json()) as {
          detail?: { supported?: unknown; received?: unknown }
        } | null
        const d = json?.detail
        if (d) {
          if (Array.isArray(d.supported)) {
            supported = d.supported
              .map((v) => (typeof v === "number" ? v : Number(v)))
              .filter((n) => Number.isFinite(n))
          }
          if (typeof d.received === "number") received = d.received
          else if (typeof d.received === "string") {
            const n = Number(d.received)
            if (Number.isFinite(n)) received = n
          }
        }
      } catch {
        // Body wasn't JSON / detail missing — throw with what we have.
      }
      throw new ProtocolVersionMismatchError(supported, received)
    }
    if (response.status === 429) {
      // Phase 4 added `tier` and `resets_at_epoch` to the 429 JSON body
      // (under `detail`). Phase-7 (this PR) appends `current` / `limit`
      // / `key_type` so the chat usage chip can hydrate from the
      // rejection without a follow-up successful turn. Old servers omit
      // any of these — we still get a usable generic "rate limited"
      // message via the header.
      let tier: string | undefined
      let resetsAtEpoch: number | undefined
      let current: number | undefined
      let limit: number | undefined
      let keyType: "user" | "ip" | undefined
      try {
        const json = (await response.clone().json()) as {
          detail?: {
            tier?: string
            resets_at_epoch?: number
            current?: number
            limit?: number
            key_type?: string
          }
        } | null
        const d = json?.detail
        if (d) {
          if (typeof d.tier === "string") tier = d.tier
          if (typeof d.resets_at_epoch === "number") resetsAtEpoch = d.resets_at_epoch
          if (typeof d.current === "number") current = d.current
          if (typeof d.limit === "number") limit = d.limit
          if (d.key_type === "user" || d.key_type === "ip") keyType = d.key_type
        }
      } catch {
        // Body wasn't JSON / detail missing — fall back to header-only.
      }
      // How long to wait, as the SERVER measured it. Either source is a
      // duration the server computed against its own clock, so it survives a
      // device whose clock is wrong; the store counts it down from `now`.
      // When neither is available the field is simply absent and the store
      // falls back to the absolute `resets_at_epoch` — never to a number this
      // layer made up.
      const retryAfter =
        parseRetryAfterSeconds(response.headers.get("Retry-After")) ??
        serverMeasuredWaitSeconds(response.headers.get("Date"), resetsAtEpoch)
      yield {
        type: "error",
        code: "rate_limited",
        message: "Too many requests",
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(tier !== undefined ? { tier } : {}),
        ...(resetsAtEpoch !== undefined ? { resetsAtEpoch } : {}),
        ...(current !== undefined ? { current } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(keyType !== undefined ? { keyType } : {}),
      }
      return
    }
    // 503 with `code: "rate_limit_backend_unavailable"` means Redis is
    // down so the server can't make a quota decision. Distinct from a
    // plain 503 (server warming up / gateway burp) which should still
    // fall through to the SSE error path so the bubble can retry. Other
    // 503 shapes (no code, different code) keep the existing handling.
    if (response.status === 503) {
      try {
        const json = (await response.clone().json()) as {
          detail?: { code?: unknown }
        } | null
        const code = json?.detail?.code
        if (typeof code === "string" && code === "rate_limit_backend_unavailable") {
          throw new BackendUnavailableError()
        }
      } catch (err) {
        // Re-throw the typed error so the catch above doesn't swallow it
        // while parsing a malformed body. Any other parse failure means
        // the body wasn't the rate-limit shape — fall through to the
        // generic http_503 path below.
        if (err instanceof BackendUnavailableError) throw err
      }
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

  // Server emits `usage` from its SSE finally-block AFTER `done` / `error`,
  // so we can't bail on the terminal event — we have to keep reading
  // until the server closes its side. We do flip a flag so we only
  // forward post-terminal frames the consumer cares about (`usage`); any
  // stray delta after a `done` would be a server bug we shouldn't fold
  // into the assistant bubble.
  let sawTerminal = false
  try {
    while (true) {
      const { done, value } = await readWithStallTimeout(reader, SSE_STALL_TIMEOUT_MS)
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
        if (sawTerminal && event.type !== "usage") continue
        yield event
        if (event.type === "done" || event.type === "error") sawTerminal = true
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return
    // A stall lands here too, and deliberately keeps `code: "stream"`: that is
    // the code the store reads as a resumable drop (`useChatStore`), so the
    // turn keeps its thinking placeholder and recovers the buffered answer
    // through the resume poll instead of showing a failed bubble.
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

/**
 * Map domain turns to the server's `ChatMessageDto` shape.
 *
 * Two fields ride BACK on an assistant turn, and both are load-bearing:
 * `aliases` so the agent sees one numbering scheme across the conversation,
 * and `attributes` — what the server settled about the dialogue, e.g. the reply
 * language. The attributes here are the per-message record; what actually
 * carries a setting past the 20 messages the server can see is the aggregate
 * `buildRequestBody` folds out of the full local history.
 *
 * Exported for tests, like `parseStoredFrame`: this is the seam where a field
 * silently stops being sent and everything still looks fine locally.
 */
/**
 * Fold every turn's attributes into ONE map for the request metadata.
 *
 * The server can only see the last 20 messages, so an attribute settled twenty
 * exchanges ago would fall out of its view. The client has the whole
 * conversation, so it folds it here and sends the result once. Later turns win,
 * and something the user STATED is not overwritten by a later inference — the
 * same rule the server applies, because both sides fold the same data and must
 * not disagree about it.
 */
export function aggregateAttributes(messages: readonly ChatTurn[]): ChatAttributes | undefined {
  const out: Record<string, ChatAttribute> = {}
  for (const m of messages) {
    if (m.role !== "assistant" || !m.attributes) continue
    for (const [key, attr] of Object.entries(m.attributes)) {
      if (attributeValues(attr).length === 0) continue
      const previous = out[key]
      if (previous && previous.explicit && !attr.explicit) continue
      out[key] = attr
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * How many turns the request body may carry — `ChatRequestDto.messages` is
 * `max_length=20` server-side and pydantic REJECTS a longer list (422), it does
 * not truncate. The client used to ship its whole local history, so a
 * conversation was permanently unsendable from its 21st message on (#1771).
 */
export const CHAT_HISTORY_WINDOW = 20

export function toWireTurns(messages: readonly ChatTurn[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.role !== "assistant") return out
    // Attributes ride back on the message as provenance; the authoritative
    // copy is the request-level aggregate `buildRequestBody` sends.
    if (m.attributes && Object.keys(m.attributes).length > 0) {
      out.attributes = m.attributes
    }
    // snake_case on the wire (track_id / start_ms / end_ms); the domain side is
    // camelCase, so the boundary transforms here.
    if (m.aliases && Object.keys(m.aliases).length > 0) {
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
}

function buildRequestBody(
  messages: readonly ChatTurn[],
  lang: string,
  opts: StreamChatRequestInit
): Record<string, unknown> {
  // Newest turns win: the tail is the live exchange, and the current user
  // prompt is always last. Order matters below — the aggregate folds the FULL
  // history, so the slice must not reach `aggregateAttributes`, otherwise a
  // setting made early in a long conversation would drop off the wire with the
  // messages that carried it.
  const windowed =
    messages.length > CHAT_HISTORY_WINDOW ? messages.slice(-CHAT_HISTORY_WINDOW) : messages
  const body: Record<string, unknown> = { messages: toWireTurns(windowed), lang }
  // Turn metadata, not per-message state: what the conversation has settled so
  // far, folded over the client's FULL local history.
  const attributes = aggregateAttributes(messages)
  if (attributes) body.attributes = attributes
  // Only emit the flag when the caller opted in — keeps the body identical
  // to the pre-feature shape (and the server default) when it's off.
  if (opts.translateCitations) body.translate_citations = true
  // Client render capabilities — only emit when non-empty so the body stays
  // byte-identical to the pre-feature shape for callers that pass none.
  if (opts.capabilities && Object.keys(opts.capabilities).length > 0) {
    body.capabilities = opts.capabilities
  }
  if (opts.sessionId !== undefined) body.session_id = opts.sessionId
  if (opts.sessionTitle !== undefined) body.session_title = opts.sessionTitle
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
 * Token provider — each chatClient function takes one in its opts.
 * Adapters thread the auth port through their own constructor, so
 * there's no module-level state to worry about across tests / multiple
 * instances. Tests can pass a synthetic provider directly into the opts.
 */
export type AccessTokenProvider = () => Promise<string | null>

/**
 * HTTP call to the chat service. `path` is relative (e.g. `/chat`,
 * `/title`, `/questions`, `/chat/feedback`); the implementation
 * prepends the active server's chat base URL and handles failover.
 * Wired by the composition root via `createFailoverClient`.
 */
export type ChatRequest = (path: string, init?: RequestInit) => Promise<Response>

async function resolveAccessToken(provider: AccessTokenProvider): Promise<string> {
  const token = await provider()
  if (!token) {
    throw new Error("chatClient: auth.getAccessToken returned null (session unrecoverable)")
  }
  return token
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
      const attributes = parseAttributes(payload.attributes)
      return {
        type: "done",
        ...(aliases ? { aliases } : {}),
        ...(attributes ? { attributes } : {}),
      }
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
    case "error": {
      // Phase-4 rate-limit responses also carry `tier` + `resets_at_epoch`
      // (both inline 429 JSON and the SSE error event). Without them the
      // bubble falls all the way through the tier ladder and lands on the
      // generic "Не удалось получить ответ" / `errUnknown` copy — the user
      // sees a confusing "failed" message, taps Retry, and only then sees
      // the real "daily limit" reason.
      const tier = typeof payload.tier === "string" ? payload.tier : undefined
      const resetsAtEpoch =
        typeof payload.resets_at_epoch === "number"
          ? payload.resets_at_epoch
          : typeof payload.resetsAtEpoch === "number"
            ? payload.resetsAtEpoch
            : undefined
      // Phase-7 (this PR) appends current / limit / key_type to mid-
      // stream rate_limited errors too so the chat usage chip can
      // hydrate without waiting for the next successful turn.
      const current = typeof payload.current === "number" ? payload.current : undefined
      const limit = typeof payload.limit === "number" ? payload.limit : undefined
      const keyTypeRaw =
        typeof payload.key_type === "string"
          ? payload.key_type
          : typeof payload.keyType === "string"
            ? payload.keyType
            : ""
      const keyType: "user" | "ip" | undefined =
        keyTypeRaw === "user" || keyTypeRaw === "ip" ? keyTypeRaw : undefined
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
        ...(tier !== undefined ? { tier } : {}),
        ...(resetsAtEpoch !== undefined ? { resetsAtEpoch } : {}),
        ...(current !== undefined ? { current } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(keyType !== undefined ? { keyType } : {}),
      }
    }
    case "usage": {
      const scope = typeof payload.scope === "string" ? payload.scope : "chat"
      const current = typeof payload.current === "number" ? payload.current : -1
      const limit = typeof payload.limit === "number" ? payload.limit : -1
      const resetsAtEpoch =
        typeof payload.resets_at_epoch === "number"
          ? payload.resets_at_epoch
          : typeof payload.resetsAtEpoch === "number"
            ? payload.resetsAtEpoch
            : -1
      // Server should always send all four; if any field is missing
      // (old server / malformed payload) drop the event silently —
      // showing a chip with `-1/-1` would be worse than showing none.
      if (current < 0 || limit <= 0 || resetsAtEpoch <= 0) return null
      return { type: "usage", scope, current, limit, resetsAtEpoch }
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

function parseAttributes(raw: unknown): ChatAttributes | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, ChatAttribute> = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    // The server sends an attribute only when it actually settled one, so an
    // empty value is a malformed frame. An unknown KEY is kept and carried
    // forward — that is what lets the server add an attribute without a client
    // release. The value is isomorphic: string for single-valued, array for
    // multi-valued; kept in the shape it arrived in.
    const rawValue = o.value
    const listed =
      typeof rawValue === "string"
        ? [rawValue]
        : Array.isArray(rawValue)
          ? rawValue.filter((v): v is string => typeof v === "string")
          : []
    // Trim, drop blanks, de-duplicate keeping order — the same normalisation the
    // server applies, so a stored attribute is clean on both sides.
    const clean = [...new Set(listed.map((v) => v.trim()).filter((v) => v.length > 0))]
    if (clean.length === 0) continue
    out[key] = {
      value: typeof rawValue === "string" ? clean[0]! : clean,
      label: typeof o.label === "string" ? o.label : "",
      explicit: o.explicit === true,
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseVersePayload(p: Record<string, unknown>): VersePayload | null {
  const sourceId = typeof p.source_id === "string" ? p.source_id : ""
  const tokens = typeof p.tokens === "string" ? p.tokens : ""
  if (!sourceId || !tokens) return null
  const addrLabel = typeof p.addr_label === "string" ? p.addr_label : ""
  const sanskrit = typeof p.sanskrit === "string" ? p.sanskrit : ""
  const transliteration = typeof p.transliteration === "string" ? p.transliteration : ""
  const transliterationOriginal =
    typeof p.transliteration_original === "string" && p.transliteration_original
      ? p.transliteration_original
      : undefined
  const translation: Record<string, string> = {}
  if (p.translation && typeof p.translation === "object" && !Array.isArray(p.translation)) {
    for (const [lang, text] of Object.entries(p.translation as Record<string, unknown>)) {
      if (typeof text === "string" && text) translation[lang] = text
    }
  }
  const audioUrl = typeof p.audio_url === "string" && p.audio_url ? p.audio_url : undefined
  const mt = p.mt === true
  const lang = typeof p.lang === "string" && p.lang ? p.lang : undefined
  return {
    source_id: sourceId,
    tokens,
    addr_label: addrLabel,
    sanskrit,
    transliteration,
    ...(transliterationOriginal ? { transliteration_original: transliterationOriginal } : {}),
    ...(lang ? { lang } : {}),
    translation,
    ...(audioUrl ? { audio_url: audioUrl } : {}),
    ...(mt ? { mt: true } : {}),
  }
}

function parseCiteTranscriptPayload(p: Record<string, unknown>): CiteTranscriptPayload | null {
  const trackId = typeof p.track_id === "string" ? p.track_id : ""
  const startMs = typeof p.start_ms === "number" ? p.start_ms : null
  const endMs = typeof p.end_ms === "number" ? p.end_ms : null
  const text = typeof p.text === "string" ? p.text.trim() : ""
  // Empty text is useless — the card would fall back to the chip anyway,
  // so drop the event rather than caching a blank snippet.
  if (!trackId || startMs === null || endMs === null || !text) return null
  const mt = p.mt === true
  const textOriginal =
    mt && typeof p.text_original === "string" && p.text_original.trim()
      ? p.text_original.trim()
      : undefined
  return {
    track_id: trackId,
    start_ms: startMs,
    end_ms: endMs,
    text,
    ...(mt ? { mt: true } : {}),
    ...(textOriginal ? { text_original: textOriginal } : {}),
  }
}

function parseCommentaryPayload(p: Record<string, unknown>): CommentaryPayload | null {
  const ref = typeof p.ref === "number" ? p.ref : null
  const text = typeof p.text === "string" ? p.text.trim() : ""
  // No ref or empty text ⇒ the card has nothing to render; drop the event.
  if (ref === null || !text) return null
  const mt = p.mt === true
  const textOriginal =
    mt && typeof p.text_original === "string" && p.text_original.trim()
      ? p.text_original.trim()
      : undefined
  return {
    ref,
    text,
    author_name: typeof p.author_name === "string" ? p.author_name : "",
    addr_label: typeof p.addr_label === "string" ? p.addr_label : "",
    kind: typeof p.kind === "string" ? p.kind : "commentary",
    ...(mt ? { mt: true } : {}),
    ...(textOriginal ? { text_original: textOriginal } : {}),
  }
}

function parseChapterPayload(p: Record<string, unknown>): ChapterPayload | null {
  const sourceId = typeof p.source_id === "string" ? p.source_id : ""
  // region_token may be "" for book-level regions (e.g. BG) — that's valid.
  const regionToken = typeof p.region_token === "string" ? p.region_token : null
  if (!sourceId || regionToken === null) return null
  const regionLabel = typeof p.region_label === "string" ? p.region_label : ""
  const chapters: { tokens: string; title: string; title_original?: string }[] = []
  if (Array.isArray(p.chapters)) {
    for (const c of p.chapters) {
      if (c && typeof c === "object") {
        const entry = c as Record<string, unknown>
        const tokens = typeof entry.tokens === "string" ? entry.tokens : ""
        const title = typeof entry.title === "string" ? entry.title : ""
        // Only present when the server machine-translated the title; keep it
        // so ChapterCard can offer the "view original" flip every other
        // translated card in the same bubble already has.
        const titleOriginal =
          typeof entry.title_original === "string" && entry.title_original.trim()
            ? entry.title_original
            : undefined
        if (tokens) {
          chapters.push({
            tokens,
            title,
            ...(titleOriginal ? { title_original: titleOriginal } : {}),
          })
        }
      }
    }
  }
  if (chapters.length === 0) return null
  const mt = p.mt === true
  return {
    source_id: sourceId,
    region_token: regionToken,
    region_label: regionLabel,
    chapters,
    ...(mt ? { mt: true } : {}),
  }
}

function parseMediaPayload(p: Record<string, unknown>): MediaPayload | null {
  const id = typeof p.id === "string" ? p.id : ""
  const url = typeof p.url === "string" ? p.url : ""
  const typeRaw = typeof p.type === "string" ? p.type : ""
  const type = typeRaw === "video" || typeRaw === "audio" ? typeRaw : null
  // A media card with no file or an unknown type is useless — drop the
  // event rather than render an empty/broken player.
  if (!id || !url || type === null) return null
  const title = typeof p.title === "string" ? p.title : ""
  const text = typeof p.text === "string" ? p.text : ""
  const speaker = typeof p.speaker === "string" && p.speaker ? p.speaker : undefined
  // Half the attribution line. Dropping it here is what made MediaCard fall
  // back to rendering the server's "<speaker> · <date>" label as BOTH the
  // title and the attribution.
  const date = typeof p.date === "string" && p.date ? p.date : undefined
  const mt = p.mt === true
  const textOriginal =
    mt && typeof p.text_original === "string" && p.text_original.trim()
      ? p.text_original.trim()
      : undefined
  return {
    id,
    url,
    type,
    title,
    text,
    ...(speaker ? { speaker } : {}),
    ...(date ? { date } : {}),
    ...(mt ? { mt: true } : {}),
    ...(textOriginal ? { text_original: textOriginal } : {}),
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
      const transcriptKey = typeof it.transcript_key === "string" ? it.transcript_key : ""
      if (!trackId || !transcriptKey) continue
      const refsRaw = Array.isArray(it.references) ? it.references : []
      const references: SharePdfRefPayload[] = []
      for (const r of refsRaw) {
        if (!r || typeof r !== "object") continue
        const ro = r as Record<string, unknown>
        references.push({
          shortName: typeof ro.short_name === "string" ? ro.short_name : null,
          fullName: typeof ro.full_name === "string" ? ro.full_name : null,
          sourceId: typeof ro.source_id === "string" ? ro.source_id : null,
          tokens: typeof ro.tokens === "string" ? ro.tokens : null,
        })
      }
      const tags = Array.isArray(it.tags)
        ? it.tags.filter((x): x is string => typeof x === "string")
        : []
      items.push({
        trackId,
        lang: typeof it.lang === "string" ? it.lang : "",
        title: typeof it.title === "string" ? it.title : trackId,
        author: typeof it.author === "string" ? it.author : null,
        date: typeof it.date === "string" ? it.date : null,
        location: typeof it.location === "string" ? it.location : null,
        references,
        tags,
        transcriptKey,
      })
    }
    if (items.length === 0) return null
    return { kind: "share_pdf", id, payload: { items } }
  }
  if (kind === "enable_daily_reminder") {
    // Bounded HH:MM — reject out-of-range times (e.g. "25:99") at parse so
    // they fall back to the 07:00 default instead of rendering a card that
    // throws on Confirm (the executor re-validates with the same bounds).
    const time =
      typeof body.time === "string" && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(body.time)
        ? body.time
        : "07:00"
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
  if (kind === "cite_transcript") {
    const cp = parseCiteTranscriptPayload(body)
    return cp ? { kind: "cite_transcript", id, payload: cp } : null
  }
  if (kind === "chapter") {
    const chp = parseChapterPayload(body)
    return chp ? { kind: "chapter", id, payload: chp } : null
  }
  if (kind === "media") {
    const mp = parseMediaPayload(body)
    return mp ? { kind: "media", id, payload: mp } : null
  }
  if (kind === "commentary") {
    const cmp = parseCommentaryPayload(body)
    return cmp ? { kind: "commentary", id, payload: cmp } : null
  }
  if (kind === "add_to_library") {
    const url = typeof body.url === "string" ? body.url : ""
    if (!url) return null
    return {
      kind: "add_to_library",
      id,
      payload: {
        url,
        title: typeof body.title === "string" ? body.title : "",
        author: typeof body.author === "string" ? body.author : null,
        thumbnail: typeof body.thumbnail === "string" ? body.thumbnail : null,
      },
    }
  }
  return null
}
