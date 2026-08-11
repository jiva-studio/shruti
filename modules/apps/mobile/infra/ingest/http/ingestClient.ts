import type {
  IIngestClient,
  IngestSubmitRequest,
  IngestSubmitResponse,
  IngestStatusResponse,
} from "@lib/contracts"

/**
 * HTTP adapter for the orchestrator's ingest control plane — the infrastructure
 * implementation of the `IIngestClient` transport port. It hits
 * `POST {orchestratorBaseUrl}/orchestrator/run` and
 * `GET {orchestratorBaseUrl}/orchestrator/run/{id}`, attaching the shared
 * RS256 JWT via the same auth/token port the sync + chat clients use.
 *
 * Scope is **pure transport**: serialize → call → deserialize. The "should we
 * submit / poll at all" decisions live in the caller (the library store),
 * exactly as `syncClient` leaves the gating to the sync engine. Parallels
 * `@infra/sync/http/syncClient.ts`.
 */

/** JWT provider, threaded through the constructor (no module-level state). */
export type AccessTokenProvider = () => Promise<string | null>

/**
 * Failover-aware HTTP call to the orchestrator. `path` is relative (e.g.
 * `/orchestrator/run`); the implementation prepends the active region's
 * `orchestratorBaseUrl`. Wired by the composition root via `createFailoverClient`,
 * exactly like the sync / chat / auth clients.
 */
export type IngestRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface HttpIngestClientDeps {
  readonly getAccessToken: AccessTokenProvider
  readonly request: IngestRequest
}

/**
 * Typed error for a non-2xx response, surfacing the server's
 * `{ error: { code, message } }` envelope so a caller can branch on `code`
 * (e.g. `not_pro` → open the paywall). Mirrors `SyncGatewayError`.
 */
export class IngestGatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = "IngestGatewayError"
  }
}

/**
 * Cap on one control-plane call. Both routes are cheap (one row written, one row
 * read), so anything this slow is a connection the mobile network dropped
 * without an RST — which `fetch` would otherwise sit on until the OS TCP timeout,
 * minutes later. Callers gate on the call being in flight (the library store's
 * double-tap guard), so an unbounded hang reads as a dead button.
 */
const REQUEST_TIMEOUT_MS = 15_000

/** Build the `IIngestClient` HTTP adapter. */
export function createHttpIngestClient(deps: HttpIngestClientDeps): IIngestClient {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await deps.getAccessToken()
    if (!token) {
      throw new IngestGatewayError(0, "no access token for ingest request")
    }
    try {
      return await deps.request(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if ((err as { name?: string })?.name === "TimeoutError") {
        throw new IngestGatewayError(0, "ingest api timed out", "timeout")
      }
      throw err
    }
  }

  async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let code: string | undefined
      try {
        const j = (await res.json()) as { error?: { code?: string } }
        code = j?.error?.code
      } catch {
        // non-JSON error body — leave code undefined
      }
      throw new IngestGatewayError(res.status, `ingest api responded ${res.status}`, code)
    }
    return (await res.json()) as T
  }

  return {
    async submit(req: IngestSubmitRequest): Promise<IngestSubmitResponse> {
      const res = await call("POST", "/orchestrator/run", req)
      return parse<IngestSubmitResponse>(res)
    },
    async status(runId: string): Promise<IngestStatusResponse> {
      const res = await call("GET", `/orchestrator/run/${encodeURIComponent(runId)}`)
      return parse<IngestStatusResponse>(res)
    },
  }
}
