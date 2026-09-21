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

export async function resolveAccessToken(provider: AccessTokenProvider): Promise<string> {
  const token = await provider()
  if (!token) {
    throw new Error("chatClient: auth.getAccessToken returned null (session unrecoverable)")
  }
  return token
}

export function isTransientStatus(code: number): boolean {
  // 502/503/504 cover redeploy and gateway downtime — retrying typically
  // succeeds once the next instance comes up. 408 (Request Timeout) is
  // intentionally NOT retried: it's almost always "the server is too
  // busy / IDLE'd out the request", and retrying compounds the load
  // without actually changing whether the server can answer.
  return code === 502 || code === 503 || code === 504
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

/** Parse a `Retry-After` header value. Returns seconds, capped to 60s
 *  so a server bug or proxy can't pin the client to a multi-hour wait. */
export function parseRetryAfterMs(raw: string | null, fallbackMs: number): number {
  if (!raw) return fallbackMs
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.min(60_000, n * 1000)
  // HTTP-date form is allowed by the spec but neither our backend nor
  // the relevant proxies emit it; falling back is the right move.
  return fallbackMs
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return `HTTP ${response.status}`
  }
}
