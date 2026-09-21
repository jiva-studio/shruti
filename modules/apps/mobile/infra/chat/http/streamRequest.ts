import type { ChatTurn } from "@lib/contracts"
import type { StreamChatRequestInit } from "./chatClient.js"
import { buildRequestBody } from "./chatRequestBody.js"
import { requestWithHeadersTimeout, CHAT_HEADERS_TIMEOUT_MS } from "./headersTimeout.js"
import {
  isTransientStatus,
  newIdempotencyKey,
  parseRetryAfterMs,
  resolveAccessToken,
  sleep,
} from "./chatHttp.js"

/** `Idempotency-Key` is per turn so a retried POST can be deduplicated: two
 *  attempts after a proxy's 502 would otherwise both bill the model. */
export async function buildStreamRequest(
  messages: readonly ChatTurn[],
  lang: string,
  opts: StreamChatRequestInit
): Promise<RequestInit> {
  const token = await resolveAccessToken(opts.getAccessToken)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${token}`,
    "X-Chat-Protocol-Version": "1",
    "Idempotency-Key": newIdempotencyKey(),
  }
  const traceId = opts.assistantMessageId?.replace(/-/g, "").toLowerCase()
  // The assistant message id doubles as the Langfuse trace id; hyphenless
  // matches OTel's 32-hex requirement. Absent, the server mints its own.
  if (traceId && /^[0-9a-f]{32}$/.test(traceId)) headers["X-Trace-Id"] = traceId
  return {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(messages, lang, opts)),
    signal: opts.signal,
  }
}

/** Nothing follows the third attempt, so waiting only delays the failure the
 *  user is already looking at. */
function isFinalAttempt(response: Response | null, attempt: number): boolean {
  if (response?.ok) return true
  if (response && !isTransientStatus(response.status)) return true
  return attempt === 2
}

/** The server's `Retry-After`, or 250ms / 750ms / 2250ms. */
function backoffMs(response: Response | null, attempt: number): number {
  const fallback = 250 * Math.pow(3, attempt)
  if (!response) return fallback
  return parseRetryAfterMs(response.headers.get("Retry-After"), fallback)
}

export interface StreamAttempt {
  readonly response: Response | null
  readonly lastErr: unknown
  readonly aborted: boolean
}

/**
 * Up to three attempts on a transient failure, honouring the server's
 * `Retry-After` over the exponential fallback. A non-transient status bails
 * at once, and the stream itself is never retried — once bytes flow we are
 * committed to that connection.
 */
export async function postWithRetry(
  requestInit: RequestInit,
  opts: StreamChatRequestInit
): Promise<StreamAttempt> {
  let response: Response | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) return { response: null, lastErr: null, aborted: true }
    try {
      response = await requestWithHeadersTimeout(
        opts.request,
        requestInit,
        opts.signal,
        CHAT_HEADERS_TIMEOUT_MS
      )
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        return { response: null, lastErr: null, aborted: true }
      }
      lastErr = err
      response = null
    }
    if (isFinalAttempt(response, attempt)) break
    await sleep(backoffMs(response, attempt), opts.signal)
  }
  return { response, lastErr, aborted: false }
}
