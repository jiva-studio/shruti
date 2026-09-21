import type { ChatRequest } from "./chatHttp.js"

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
export async function requestWithHeadersTimeout(
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
