/**
 * Thin HTTP client for the `profile` sync service, implementing the shared
 * `ISyncClient` transport contract (`@lib/contracts`) over `fetch` + a bearer
 * JWT. Pure transport: serialize → POST → deserialize; no HLC, no merge, no
 * cursor bookkeeping (the engine core owns that).
 *
 * Mirrors the mobile adapter (`@infra/sync/http/syncClient.ts`) but leaner —
 * the web has no failover, so it hits a single `profileBaseUrl`. Methods
 * reject with a {@link SyncHttpError} on a non-2xx / network failure; the
 * composable catches and leaves the local cache untouched.
 */

import type {
  CursorRequest,
  ISyncClient,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
} from "@lib/contracts"

export class SyncHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = "SyncHttpError"
  }
}

export type TokenProvider = () => Promise<string | null>

export interface WebSyncClientOptions {
  /** `profile` service base, no trailing slash (e.g. the region base). */
  baseUrl: string
  /** Resolves the signed-in user's access token, or null when unrecoverable. */
  getToken: TokenProvider
}

export function createWebSyncClient(opts: WebSyncClientOptions): ISyncClient {
  const base = opts.baseUrl.replace(/\/$/, "")

  async function post(path: string, body: unknown): Promise<Response> {
    const token = await opts.getToken()
    if (!token) throw new SyncHttpError(0, "sync: no access token", "unauthenticated")
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  }

  async function throwIfNotOk(res: Response, op: string): Promise<void> {
    if (res.ok) return
    let code: string | undefined
    let message: string | undefined
    try {
      const json = (await res.clone().json()) as {
        error?: { code?: unknown; message?: unknown }
      } | null
      const err = json?.error
      if (err) {
        if (typeof err.code === "string") code = err.code
        if (typeof err.message === "string") message = err.message
      }
    } catch {
      /* not the envelope shape */
    }
    throw new SyncHttpError(res.status, `sync ${op} failed: ${res.status} ${message ?? ""}`, code)
  }

  return {
    async pull(req: PullRequest): Promise<PullResponse> {
      const res = await post("/profile/sync/pull", req)
      await throwIfNotOk(res, "pull")
      return (await res.json()) as PullResponse
    },
    async push(req: PushRequest): Promise<PushResponse> {
      const res = await post("/profile/sync/push", req)
      await throwIfNotOk(res, "push")
      return (await res.json()) as PushResponse
    },
    async ackCursor(req: CursorRequest): Promise<void> {
      const res = await post("/profile/sync/cursor", req)
      await throwIfNotOk(res, "cursor")
    },
  }
}
