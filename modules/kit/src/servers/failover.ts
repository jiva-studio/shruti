import { joinUrl } from "./cdnServer.js"

/**
 * Single backend per request; multiple backends per app. Each entry from
 * `getServers` is a candidate the failover client may route to. The
 * preferred server is tried first; on a transient failure the client walks
 * the remaining candidates in declared order and returns the first
 * non-transient response. If the preferred server has been unreachable for
 * longer than `promoteAfterMs`, the next successful fallback is promoted to
 * preferred (and `onPromoteFallback` fires so the caller can persist the new
 * id).
 *
 * Per-request abort is honored. Same-server abort surfaces immediately; it
 * does NOT trigger a fallback (the user cancelled, not the network).
 *
 * Only requests whose method is idempotent walk the candidate list. Servers
 * are separate deployments with separate databases, so replaying a mutation
 * elsewhere lands it in a store that knows nothing about the first attempt —
 * duplicated jobs, cursors read against the wrong change log, buffers that
 * do not exist. A caller whose POST is semantically a read (a search that
 * writes nothing) opts back in with `crossServerReplay: true`.
 *
 * Generic over the server shape `S` — kit only requires an `id`. Apps pass
 * their own server type (which may carry extra fields read inside
 * `pickBaseUrl`).
 */

/** Network / 5xx is considered transient. 4xx is the server speaking; the
 *  client doesn't retry across servers on it (a 401 from preferred isn't
 *  going to flip to a 200 on the fallback). */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** Methods RFC 9110 defines as idempotent — re-issuing one against a second
 *  deployment cannot create state the first attempt already created. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"])

function mayReplayOnOtherServer(init?: FailoverRequestInit): boolean {
  if (init?.crossServerReplay !== undefined) return init.crossServerReplay
  return IDEMPOTENT_METHODS.has((init?.method ?? "GET").toUpperCase())
}

/** `crossServerReplay` is ours, not fetch's — drop it before handing the
 *  init to `fetchImpl` so nothing downstream sees an unknown key. */
function toFetchInit(init?: FailoverRequestInit): RequestInit | undefined {
  if (!init || init.crossServerReplay === undefined) return init
  const copy: FailoverRequestInit = { ...init }
  delete copy.crossServerReplay
  return copy
}

export interface FailoverRequestInit extends RequestInit {
  /**
   * Override the method-derived decision about whether this request may be
   * re-issued against a different server after a transient failure.
   *
   * `true` for a mutation-shaped read (a search POSTed because its filter
   * does not fit in a query string). `false` to pin a GET to the preferred
   * server when even a read depends on per-deployment state. Omit to let
   * the method decide.
   */
  crossServerReplay?: boolean
}

export interface FailoverClientOptions<S extends { id: string }> {
  /** Lazy getter for all known servers, in fallback order after the
   *  preferred. Read at every request so a list refreshed at runtime takes
   *  effect without rebuilding the client. Must never return an empty array. */
  getServers: () => readonly S[]
  /** Lazy getter for the currently-preferred server id. Read at every
   *  request so a settings flip takes effect on the next call. */
  getPreferredId: () => string
  /**
   * Build the per-request base URL for a given server. The caller knows
   * which of the server's fields it wants; the failover client just plumbs
   * the chosen server through.
   */
  pickBaseUrl: (server: S) => string
  /**
   * Fires when the preferred server has been continuously unreachable for
   * >= `promoteAfterMs` and a fallback just succeeded. The caller persists
   * the new preferred id here. Idempotent — fires once per actual
   * promotion, not on every fallback.
   */
  onPromoteFallback?: (newPreferredId: string) => void
  /** How long the preferred server must be unreachable before a successful
   *  fallback gets promoted. Default: 5 minutes. */
  promoteAfterMs?: number
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

export interface FailoverClient {
  /**
   * Build a full URL by prepending the currently-active server's base to
   * `path`. Read at call time — does NOT account for fallback that happens
   * during the request itself. Use `request` for fetches that should
   * auto-fall-through.
   */
  resolveUrl(path: string): string
  /**
   * Make a request that auto-falls-through on transient failures. The
   * caller passes a path (relative to whatever `pickBaseUrl` returns).
   * Returns the first non-transient response. On total failure throws the
   * last error.
   *
   * Fall-through applies to idempotent methods only; anything else is tried
   * against the preferred server alone and its transient failure is thrown.
   * See `crossServerReplay` to override per request.
   */
  request(path: string, init?: FailoverRequestInit): Promise<Response>
}

const DEFAULT_PROMOTE_AFTER_MS = 5 * 60 * 1000

export function createFailoverClient<S extends { id: string }>(
  opts: FailoverClientOptions<S>
): FailoverClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const promoteAfterMs = opts.promoteAfterMs ?? DEFAULT_PROMOTE_AFTER_MS

  // First wall-clock at which the preferred server was observed unreachable
  // without an intervening recovery. -1 means "currently reachable" (no
  // outage in flight). Avoid using 0 as a sentinel — tests inject
  // controlled clocks that start at 0.
  let preferredUnreachableSince = -1
  // The id we last considered "preferred"; resets the unreachable counter
  // whenever the upstream picker changes (user manually flipped).
  let lastObservedPreferredId: string | null = null

  function orderedCandidates(preferredId: string): S[] {
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

  async function request(path: string, init?: FailoverRequestInit): Promise<Response> {
    const preferredId = opts.getPreferredId()
    if (lastObservedPreferredId !== preferredId) {
      lastObservedPreferredId = preferredId
      preferredUnreachableSince = -1
    }
    // A non-replayable request still records the preferred server's outage
    // (so a later read can promote a fallback), it just never leaves the
    // preferred deployment itself.
    const candidates = mayReplayOnOtherServer(init)
      ? orderedCandidates(preferredId)
      : orderedCandidates(preferredId).slice(0, 1)
    const fetchInit = toFetchInit(init)

    let lastError: unknown = null
    for (let i = 0; i < candidates.length; i++) {
      const server = candidates[i]!
      const url = joinUrl(opts.pickBaseUrl(server), path)
      try {
        const response = await fetchImpl(url, fetchInit)
        if (response.ok || !isTransientStatus(response.status)) {
          // Non-transient response — the server is reachable and answering,
          // even if with a 4xx. Done.
          if (server.id === preferredId) {
            preferredUnreachableSince = -1
          } else {
            // A fallback answered. If the preferred has been down long
            // enough, promote this one so the next request goes to it first
            // and the caller can reflect the change.
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
