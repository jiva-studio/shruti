// A request that never reached a responding server (offline, DNS, reset, TLS,
// or an Android-WebView CORS rejection) surfaces as the same opaque
// `TypeError: Failed to fetch`, collapsing every endpoint into one Sentry
// issue. Naming the method + path gives a per-endpoint title; call sites can
// `instanceof NetworkError` to show a proper "no connection" message.

export class NetworkError extends Error {
  override name = "NetworkError"
  constructor(
    readonly method: string,
    readonly path: string,
    options?: { cause?: unknown }
  ) {
    super(`${method} ${path} — network unreachable`, options)
  }
}

// The failover client RETURNS 4xx/5xx as a Response, so a thrown value is
// either fetch's `TypeError: Failed to fetch` (the network failure) or an
// AbortError (caller cancelled — not a fault).
function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkError) return false // already named
  if ((error as { name?: unknown } | null)?.name === "AbortError") return false
  return error instanceof TypeError
}

type RequestFn = (path: string, init?: RequestInit) => Promise<Response>

// Decorate a failover request fn so a network failure rethrows as a
// NetworkError naming the method + path. Responses, aborts, and already-named
// errors pass through unchanged, so SSE streaming is unaffected.
export function withNetworkErrorContext(request: RequestFn): RequestFn {
  return async (path, init) => {
    try {
      return await request(path, init)
    } catch (error) {
      if (isNetworkFailure(error)) {
        const method = (init?.method ?? "GET").toUpperCase()
        throw new NetworkError(method, path, { cause: error })
      }
      throw error
    }
  }
}
