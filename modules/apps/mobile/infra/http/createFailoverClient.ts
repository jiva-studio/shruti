import type { CdnServer } from "@lib/domain/servers.js"

/**
 * Single backend per request; multiple backends per app. Each entry in
 * `servers` is a candidate the failover client may route to. The
 * preferred server is tried first; on a transient failure the client
 * walks the remaining candidates in declared order and returns the
 * first non-transient response. If the preferred server has been
 * unreachable for longer than `promoteAfterMs`, the next successful
 * fallback is promoted to preferred (and the listener fires so the
 * Settings store can mirror the new id).
 *
 * Per-request abort is honored. Same-server abort surfaces immediately;
 * it does NOT trigger a fallback (the user cancelled, not the network).
 */

/** Network / 5xx is considered transient. 4xx is the server speaking;
 *  the client doesn't retry across servers on it (a 401 from preferred
 *  isn't going to flip to a 200 on the fallback). */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

export interface FailoverClientOptions {
  /** Lazy getter for all known servers, in fallback order after the
   *  preferred. Read at every request so a region list refreshed from the
   *  remote config (regionsRegistry) takes effect without rebuilding the
   *  client. Must never return an empty array. */
  getServers: () => readonly CdnServer[]
  /** Lazy getter for the currently-preferred server id. Read at every
   *  request so a settings flip takes effect on the next call. */
  getPreferredId: () => string
  /**
   * Build the per-request URL for a given server. The caller knows
   * whether it wants `server.authBaseUrl`, `server.chatBaseUrl`, etc;
   * the failover client just plumbs the chosen server through.
   */
  pickBaseUrl: (server: CdnServer) => string
  /**
   * Fires when the preferred server has been continuously unreachable
   * for >= `promoteAfterMs` and a fallback just succeeded. The store
   * persists `preferredServerId` here so Settings reflects the change.
   * Idempotent — fires once per actual promotion, not on every fallback.
   */
  onPromoteFallback?: (newPreferredId: string) => void
  /** How long the preferred server must be unreachable before a
   *  successful fallback gets promoted. Default: 5 minutes. */
  promoteAfterMs?: number
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

export interface FailoverClient {
  /**
   * Build a full URL by prepending the currently-active server's base
   * to `path`. Read at call time — does NOT account for fallback that
   * happens during the request itself. Use `request` for fetches that
   * should auto-fall-through.
   */
  resolveUrl(path: string): string
  /**
   * Make a request that auto-falls-through on transient failures. The
   * caller passes a path (relative to whatever `pickBaseUrl` returns).
   * Returns the first non-transient response. On total failure throws
   * the last error.
   */
  request(path: string, init?: RequestInit): Promise<Response>
}

const DEFAULT_PROMOTE_AFTER_MS = 5 * 60 * 1000

export function createFailoverClient(opts: FailoverClientOptions): FailoverClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const promoteAfterMs = opts.promoteAfterMs ?? DEFAULT_PROMOTE_AFTER_MS

  // First wall-clock at which the preferred server was observed
  // unreachable without an intervening recovery. -1 means "currently
  // reachable" (no outage in flight). Avoid using 0 as a sentinel —
  // tests inject controlled clocks that start at 0.
  let preferredUnreachableSince = -1
  // The id we last considered "preferred"; resets the unreachable
  // counter whenever the upstream picker changes (user manually flipped).
  let lastObservedPreferredId: string | null = null

  function orderedCandidates(preferredId: string): CdnServer[] {
    const servers = opts.getServers()
    const preferred = servers.find((s) => s.id === preferredId)
    const rest = servers.filter((s) => s.id !== preferredId)
    return preferred ? [preferred, ...rest] : [...servers]
  }

  function resolveUrl(path: string): string {
    const servers = opts.getServers()
    const preferred = servers.find((s) => s.id === opts.getPreferredId())
    const base = preferred ? opts.pickBaseUrl(preferred) : opts.pickBaseUrl(servers[0]!)
    return joinUrl(base, path)
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const preferredId = opts.getPreferredId()
    if (lastObservedPreferredId !== preferredId) {
      lastObservedPreferredId = preferredId
      preferredUnreachableSince = -1
    }
    const candidates = orderedCandidates(preferredId)

    let lastError: unknown = null
    for (let i = 0; i < candidates.length; i++) {
      const server = candidates[i]!
      const url = joinUrl(opts.pickBaseUrl(server), path)
      try {
        const response = await fetchImpl(url, init)
        if (response.ok || !isTransientStatus(response.status)) {
          // Non-transient response — the server is reachable and
          // answering, even if with a 4xx. Done.
          if (server.id === preferredId) {
            preferredUnreachableSince = -1
          } else {
            // A fallback answered. If the preferred has been down long
            // enough, promote this one so the next request goes to it
            // first and Settings reflects the change.
            maybePromote(server.id)
          }
          return response
        }
        // 5xx transient — record + fall through
        if (server.id === preferredId) {
          if (preferredUnreachableSince === -1) preferredUnreachableSince = now()
        }
        lastError = new Error(`HTTP ${response.status}`)
      } catch (err) {
        // Abort: caller cancelled — don't try fallbacks.
        if ((err as { name?: string })?.name === "AbortError") throw err
        if (server.id === preferredId) {
          if (preferredUnreachableSince === -1) preferredUnreachableSince = now()
        }
        lastError = err
      }
    }
    throw lastError ?? new Error("failover: all servers unreachable")
  }

  function maybePromote(succeededId: string): void {
    if (preferredUnreachableSince === -1) return
    if (now() - preferredUnreachableSince < promoteAfterMs) return
    preferredUnreachableSince = -1
    lastObservedPreferredId = succeededId
    opts.onPromoteFallback?.(succeededId)
  }

  return { resolveUrl, request }
}

function joinUrl(base: string, path: string): string {
  if (!path) return base
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1)
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`
  return base + path
}
