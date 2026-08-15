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

// The failover client returns 4xx and most 5xx as a Response, but THROWS
// `Error("HTTP 502")` when every candidate answers 502/503/504 — so a thrown
// value is fetch's `TypeError: Failed to fetch` (the network failure), an
// AbortError (caller cancelled — not a fault), or a transient server status
// that is not the user's connection and must not be renamed as one (#1843).
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
