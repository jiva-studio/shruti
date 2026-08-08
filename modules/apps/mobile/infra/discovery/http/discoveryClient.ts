import type {
  IDiscoveryClient,
  DiscoverySearchRequest,
  DiscoverySearchResponse,
} from "@lib/contracts"

/**
 * HTTP adapter for the discovery service's search — the infrastructure
 * implementation of the `IDiscoveryClient` transport port. It hits
 * `POST {discoveryBaseUrl}/discovery/search`, attaching the shared RS256 JWT
 * via the same auth/token port the sync, chat and ingest clients use.
 *
 * Scope is **pure transport**: serialize → call → deserialize. Whether to
 * search at all, how long to wait after a keystroke, and which of `query` /
 * `filter.text` to fill are the caller's decisions. Parallels
 * `@infra/ingest/http/ingestClient.ts`.
 */

/** JWT provider, threaded through the constructor (no module-level state). */
export type AccessTokenProvider = () => Promise<string | null>

/**
 * Failover-aware HTTP call to the discovery service. `path` is relative
 * (`/discovery/search`); the implementation prepends the active region's
 * `discoveryBaseUrl`. Wired by the composition root via `createFailoverClient`,
 * exactly like the sync / chat / ingest clients.
 */
export type DiscoveryRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface HttpDiscoveryClientDeps {
  readonly getAccessToken: AccessTokenProvider
  readonly request: DiscoveryRequest
}

/**
 * Typed error for a non-2xx response, surfacing the server's
 * `{ error: { code, message } }` envelope so a caller can branch on `code`.
 * Mirrors `IngestGatewayError`.
 *
 * `not_configured` is worth knowing by name: it means the deployment has no
 * signing key mounted, so the route refuses everyone and retrying will not
 * help.
 */
export class DiscoveryGatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = "DiscoveryGatewayError"
  }
}

/** Build the `IDiscoveryClient` HTTP adapter. */
export function createHttpDiscoveryClient(deps: HttpDiscoveryClientDeps): IDiscoveryClient {
  return {
    async search(
      req: DiscoverySearchRequest,
      options?: { readonly signal?: AbortSignal }
    ): Promise<DiscoverySearchResponse> {
      const token = await deps.getAccessToken()
      if (!token) {
        throw new DiscoveryGatewayError(0, "no access token for discovery request")
      }
      const res = await deps.request("/discovery/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(req),
        signal: options?.signal,
      })
      if (!res.ok) {
        let code: string | undefined
        try {
          const j = (await res.json()) as { error?: { code?: string } }
          code = j?.error?.code
        } catch {
          // non-JSON error body — leave code undefined
        }
        throw new DiscoveryGatewayError(res.status, `discovery api responded ${res.status}`, code)
      }
      return (await res.json()) as DiscoverySearchResponse
    },
  }
}
