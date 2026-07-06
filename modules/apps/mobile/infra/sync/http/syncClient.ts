import type {
  ISyncClient,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  CursorRequest,
} from "@lib/contracts"

/**
 * HTTP adapter for the `profile` device↔server sync service — the
 * infrastructure implementation of the `ISyncClient` transport port
 * (`@lib/contracts/sync`). It hits
 * `POST {profileBaseUrl}/profile/sync/{pull,push,cursor}`, attaches the
 * shared RS256 JWT via the same auth/token port the chat client uses, and
 * serializes / deserializes the snake_case wire DTOs.
 *
 * Scope is **pure transport**: serialize request → call → deserialize
 * response. No HLC math, no merge, no cursor bookkeeping — the sync engine
 * (`@usecases`, Lane D) owns all of that and consumes this through the
 * port. It parallels `@infra/chat/http/chatClient.ts`.
 *
 * Anonymous handling: like `chatClient`, this adapter does **not** gate on
 * the token being anonymous. It requires only a *non-null* token (throws
 * if the auth port returns null, i.e. an unrecoverable session). The
 * "should we sync at all while anonymous" decision belongs to the caller —
 * the sync engine only invokes this once the account is signed-in, exactly
 * as `chatClient` leaves the "is this user allowed" call to its store.
 */

/**
 * JWT provider — the adapter threads the auth port through its constructor
 * (`app.auth.getAccessToken`), so there is no module-level state across
 * instances / tests. Same contract as the chat client's provider.
 */
export type AccessTokenProvider = () => Promise<string | null>

/**
 * HTTP call to the `profile` service. `path` is relative (e.g.
 * `/profile/sync/pull`); the implementation prepends the active region's
 * `profileBaseUrl` and handles failover. Wired by the composition root via
 * `createFailoverClient` (Lane D), exactly like the chat / auth clients.
 */
export type SyncRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface HttpSyncClientDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the profile service. */
  readonly request: SyncRequest
}

/**
 * Typed error for a non-2xx / envelope-error response from the profile
 * service. Surfaces the server's `{ ok: false, error: { code, message,
 * details } }` envelope so a caller can branch on `code` — mirrors how
 * `chatClient` throws typed errors instead of leaking raw `Response`s.
 * Lives on the adapter (a transport concern); the domain / engine catch
 * it at the boundary and map it to a `Result`.
 */
export class SyncGatewayError extends Error {
  constructor(
    /** HTTP status code (0 when the failure was not an HTTP response). */
    public readonly status: number,
    message: string,
    /** Machine-readable `error.code` from the envelope, when present. */
    public readonly code?: string,
    /** Opaque `error.details` from the envelope, when present. */
    public readonly details?: unknown
  ) {
    super(message)
    this.name = "SyncGatewayError"
  }
}

/**
 * Build the `ISyncClient` HTTP adapter. Thin pass-through: each method
 * POSTs JSON with a bearer token and deserializes the typed response.
 */
export function createHttpSyncClient(deps: HttpSyncClientDeps): ISyncClient {
  async function post(path: string, body: unknown): Promise<Response> {
    const token = await resolveAccessToken(deps.getAccessToken)
    return deps.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  }

  return {
    async pull(req: PullRequest): Promise<PullResponse> {
      // The server derives user scope from the JWT and filters by the request
      // cursor alone — a device receives its own writes back too (re-applying
      // is an idempotent LWW no-op and the only way a wiped device recovers).
      const response = await post("/profile/sync/pull", req)
      await throwIfNotOk(response, "pull")
      return (await response.json()) as PullResponse
    },

    async push(req: PushRequest): Promise<PushResponse> {
      const response = await post("/profile/sync/push", req)
      await throwIfNotOk(response, "push")
      return (await response.json()) as PushResponse
    },

    async ackCursor(req: CursorRequest): Promise<void> {
      const response = await post("/profile/sync/cursor", req)
      await throwIfNotOk(response, "cursor")
      // No response body — the cursor ack returns 2xx with nothing to read.
    },
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

async function resolveAccessToken(provider: AccessTokenProvider): Promise<string> {
  const token = await provider()
  if (!token) {
    throw new SyncGatewayError(
      0,
      "syncClient: auth.getAccessToken returned null (session unrecoverable)",
      "unauthenticated"
    )
  }
  return token
}

/**
 * Throw a {@link SyncGatewayError} for a non-2xx response, decoding the
 * `{ ok: false, error: { code, message, details } }` envelope when the
 * body is JSON in that shape, else falling back to the status text.
 */
async function throwIfNotOk(response: Response, op: string): Promise<void> {
  if (response.ok) return
  let code: string | undefined
  let message: string | undefined
  let details: unknown
  try {
    const json = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown }
    } | null
    const err = json?.error
    if (err) {
      if (typeof err.code === "string") code = err.code
      if (typeof err.message === "string") message = err.message
      details = err.details
    }
  } catch {
    // Body was not JSON / not the envelope shape — fall back below.
  }
  const text = message ?? (await safeReadText(response))
  throw new SyncGatewayError(
    response.status,
    `sync ${op} failed: ${response.status} ${text || response.statusText}`,
    code,
    details
  )
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return `HTTP ${response.status}`
  }
}
