// Access-token freshness is decided against the LOCAL clock: the auth adapter
// hands back the cached token while `exp - Date.now() > 60s`. A device whose
// clock runs behind real time therefore never refreshes on its own, and a
// token revoked server-side stays "fresh" locally until natural rotation. In
// both cases every authenticated call 401s and no consumer reacts — the chat
// client treats 401 as terminal, the failover client treats 4xx as final.
//
// This decorator is the one place that reacts: on a 401 it forces a refresh
// and replays the request once with the new bearer. It wraps the same
// `RequestFn` shape as `withNetworkErrorContext`, so the composition root
// applies it per service client without any client knowing it exists.

type RequestFn = (path: string, init?: RequestInit) => Promise<Response>

export interface UnauthorizedRetryDeps {
  /** Unconditional refresh — bypasses the clock check. Resolves to the new
   *  access token, or `null` when the session is unrecoverable (refresh
   *  rejected) or the refresh itself failed transiently. */
  refreshAccessToken: () => Promise<string | null>
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

// After a refreshed token is itself rejected, further 401s are the server's
// verdict on a valid token (wrong audience, revoked key, a route that is
// simply forbidden), not staleness. Refreshing again would burn a round-trip
// per request forever, so back off before trying once more.
const REFRESH_COOLDOWN_MS = 60_000

/**
 * A 401 is decided by the auth middleware before the request body reaches any
 * handler, so replaying a POST cannot duplicate its effect. What a replay
 * cannot survive is a one-shot body: a `ReadableStream` is already drained by
 * the first attempt and re-sending it would throw. Everything the app sends is
 * a JSON string; anything exotic is left alone.
 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return true
  if (typeof body === "string") return true
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true
  if (typeof FormData !== "undefined" && body instanceof FormData) return true
  if (typeof Blob !== "undefined" && body instanceof Blob) return true
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
  return false
}

/**
 * Build the shared 401 interceptor and return a decorator for `RequestFn`s.
 *
 * The returned decorator is applied to every authenticated service client
 * (sync, ingest, discovery, chat) but the coalescing state lives HERE, on the
 * factory — so a token that expires while the sync engine, a chat send and an
 * ingest poll are all in flight produces exactly ONE `/auth/refresh`, not one
 * per client and not one per request.
 *
 * The coalescing is generation-based rather than a plain in-flight promise,
 * because the two races differ:
 *
 *  - Requests that 401 *while* a refresh is running join the in-flight
 *    promise (`refreshInFlight`).
 *  - A request that 401s *after* that refresh already landed — it was sent
 *    with the old bearer and simply came back late — sees `tokenGeneration`
 *    past the value it captured before its first attempt, and replays with
 *    the token already in hand instead of forcing a second refresh.
 *
 * The auth client itself is never wrapped: a 401 from `/auth/refresh` is the
 * answer, not a reason to ask again.
 */
export function createUnauthorizedRetry(
  deps: UnauthorizedRetryDeps
): (request: RequestFn) => RequestFn {
  const now = deps.now ?? Date.now

  // Bumped on every successful forced refresh. A request captures it before
  // its first attempt; a higher value at 401 time means someone else already
  // did the work.
  let tokenGeneration = 0
  let latestToken: string | null = null
  let refreshInFlight: Promise<string | null> | null = null
  let cooldownUntil = 0

  async function tokenFor(capturedGeneration: number): Promise<string | null> {
    if (now() < cooldownUntil) return null
    if (tokenGeneration > capturedGeneration) return latestToken
    const inFlight = (refreshInFlight ??= deps
      .refreshAccessToken()
      .then((token) => {
        if (token) {
          latestToken = token
          tokenGeneration += 1
        }
        return token
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null
      }))
    return inFlight
  }

  return (request: RequestFn): RequestFn =>
    async (path, init) => {
      const capturedGeneration = tokenGeneration
      const response = await request(path, init)
      if (response.status !== 401) return response

      const headers = new Headers(init?.headers)
      // No bearer means the 401 is not about our token — nothing to refresh.
      if (!headers.has("Authorization")) return response
      if (!isReplayableBody(init?.body)) return response

      const token = await tokenFor(capturedGeneration)
      // No token: the refresh was rejected (session cleared), failed
      // transiently, or the cooldown is open. Surface the original 401 and
      // let the caller's own error handling run — never loop here.
      if (!token) return response

      headers.set("Authorization", `Bearer ${token}`)
      // Exactly one replay, non-recursive: a second 401 is returned as-is.
      const replayed = await request(path, { ...init, headers })
      cooldownUntil = replayed.status === 401 ? now() + REFRESH_COOLDOWN_MS : 0
      return replayed
    }
}
