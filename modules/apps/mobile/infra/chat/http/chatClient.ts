import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"

import { classifyChatTransportFailure } from "./chatTransportFailure.js"
import { readSseStream, SSE_STALL_TIMEOUT_MS } from "./sseReader.js"
import { safeReadText, type AccessTokenProvider, type ChatRequest } from "./chatHttp.js"
import { buildStreamRequest, postWithRetry } from "./streamRequest.js"
import {
  rateLimitedEvent,
  readRateLimitDetail,
  throwIfBackendUnavailable,
  throwProtocolMismatch,
} from "./streamErrors.js"

// Re-export so the mobile store + tests can import either from the
// domain barrel or directly off the chat HTTP adapter — keeps the
// import path short at call-sites that already pull other types from
// this module.
export { BackendUnavailableError, ProtocolVersionMismatchError }
export { SSE_STALL_TIMEOUT_MS }
export * from "./chatEndpoints.js"
export { CHAT_HEADERS_TIMEOUT_MS } from "./headersTimeout.js"
export { aggregateAttributes, toWireTurns, CHAT_HISTORY_WINDOW } from "./chatRequestBody.js"
export * from "./chatResume.js"
export {
  resolveAccessToken,
  safeReadText,
  type AccessTokenProvider,
  type ChatRequest,
} from "./chatHttp.js"

/* -------------------------------------------------------------------------- */
/*                              Wire-protocol types                           */
/* -------------------------------------------------------------------------- */

// The SSE wire protocol is owned by `@lib/contracts` (the shared kernel) so a
// server protocol change is edited in ONE place. Imported here under shorter
// local names for the parsers below; decoded payloads stay snake_case
// (verbatim from the wire), and the `runChatTurn` use-case is the single
// boundary that maps them to the camelCase domain shapes — `media` included.
import type { ChatTurn, ChatStreamEvent } from "@lib/contracts"

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
  const requestInit = await buildStreamRequest(messages, lang, opts)
  const { response, lastErr, aborted } = await postWithRetry(requestInit, opts)
  if (aborted) return

  if (!response) {
    // Every attempt threw. WHAT threw decides the message: the failover client
    // throws `Error("HTTP 502")` when the backend is up but broken, and
    // reporting that as "check your connection" both lies and arms the
    // reconnect auto-resend (#1843).
    yield {
      type: "error",
      code: classifyChatTransportFailure(lastErr),
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
    if (response.status === 426) await throwProtocolMismatch(response)
    if (response.status === 429) {
      const detail = await readRateLimitDetail(response)
      // How long to wait, as the SERVER measured it: either source is a
      // duration computed against its own clock, so it survives a device whose
      // clock is wrong. With neither the field is absent and the store falls
      // back to the absolute reset time — never to a number this layer made up.
      const retryAfter =
        parseRetryAfterSeconds(response.headers.get("Retry-After")) ??
        serverMeasuredWaitSeconds(response.headers.get("Date"), detail.resetsAtEpoch)
      yield rateLimitedEvent(detail, retryAfter)
      return
    }
    // A plain 503 (server warming up, gateway burp) stays on the retryable
    // path below; only the quota-store outage is structural.
    if (response.status === 503) await throwIfBackendUnavailable(response)
    const text = await safeReadText(response)
    yield { type: "error", code: `http_${response.status}`, message: text }
    return
  }

  const body = response.body
  if (!body) {
    yield { type: "error", code: "no_body", message: "Empty response body" }
    return
  }

  yield* readSseStream(body)
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
