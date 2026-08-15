// Nothing under this decorator imposes a deadline. `CapacitorHttp` is off, so
// every call is the WebView's `fetch`, and the failover client honours only a
// caller-supplied signal — which three of the four authenticated clients never
// pass. Plain offline is harmless (fetch rejects at once); what hangs forever
// is a socket that completes the handshake and then never answers — a captive
// portal, a black-holing middlebox, a dying cell handover.
//
// The damage is not the one lost request but the guards built around it: auth
// memoises `/refresh` in `refreshInFlight`, the sync engine latches `inFlight`,
// the library store gates on its poll being in flight. Each clears in a
// `finally` that a never-settling fetch never reaches, so one hung socket
// wedges that subsystem for the rest of the process. A deadline is what turns
// all of those back into a normal failure.

type RequestFn = (path: string, init?: RequestInit) => Promise<Response>

/**
 * One call's budget. Every route this bounds is a small JSON round-trip —
 * a token rotation, a sync page, a status read, a search — so anything slower
 * than this is a connection that is not coming back, not a slow answer.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/**
 * The SSE turn stream. It is long-lived BY DESIGN — the response stays open for
 * as long as the model is speaking — so a blanket deadline would cut every
 * streaming answer mid-sentence. It carries its own bounds instead (a header
 * deadline and a stall deadline, both in `chatClient`).
 */
export function isChatStreamPath(path: string): boolean {
  return path === "/chat"
}

/** Raised when our own deadline fired. Named `TimeoutError` so it matches what
 *  `AbortSignal.timeout` produces, which callers already branch on. */
export class RequestTimeoutError extends Error {
  override name = "TimeoutError"
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number
  ) {
    super(`${method} ${path} — no response within ${timeoutMs}ms`)
  }
}

export interface RequestTimeoutOptions {
  readonly timeoutMs?: number
  /** Paths that must stay unbounded — see `isChatStreamPath`. */
  readonly skip?: (path: string) => boolean
}

/**
 * Bound a `RequestFn` with a deadline, in the same shape as
 * `withNetworkErrorContext` / `withUnauthorizedRetry` so the composition root
 * applies it per client without any client knowing it exists.
 *
 * The deadline ABORTS rather than races: a bare `Promise.race` would resolve
 * the caller while the socket stayed open, leaking a connection per call. A
 * caller's own signal is bridged into ours, so Stop / a newer search still
 * cancels, and its abort is rethrown unchanged — only OUR expiry becomes a
 * `RequestTimeoutError`.
 *
 * The timer is deliberately NOT cleared once headers land: a proxy that answers
 * and then stalls mid-body hangs the `res.json()` just as thoroughly as one
 * that never answers at all, and aborting a body already read is a no-op.
 */
export function withRequestTimeout(
  request: RequestFn,
  options: RequestTimeoutOptions = {}
): RequestFn {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return async (path, init) => {
    if (options.skip?.(path)) return request(path, init)

    const callerSignal = init?.signal ?? undefined
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
      return await request(path, { ...init, signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      if (timedOut && !callerSignal?.aborted) {
        throw new RequestTimeoutError((init?.method ?? "GET").toUpperCase(), path, timeoutMs)
      }
      throw error
    }
  }
}
