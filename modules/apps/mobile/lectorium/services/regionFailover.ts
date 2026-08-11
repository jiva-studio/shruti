import { createFailoverClient, type FailoverClient, type FailoverRequestInit } from "@kit/servers"
import type { CdnServer } from "@lib/domain/servers.js"

/**
 * How THIS app routes API calls across regions.
 *
 * kit's failover client is written for the general case — separate
 * deployments with separate databases — where replaying a mutation on
 * another server lands it in a store that knows nothing about the first
 * attempt. Lectorium is not that case. The regions are alternate *edges* in
 * front of ONE backend: the RU box runs `COMPOSE_PROFILES=proxy` and its
 * Caddy forwards `/auth/*`, `/chat`, `/profile/*` and `/orchestrator/*` to
 * the global host, and `global` / `legacy` share the same host constant.
 * One auth DB, one chat turn store, one profile DB.
 *
 * Two consequences, and this module is both of them:
 *
 *  1. A device on a dead edge must be able to walk to another door even for
 *    a POST — otherwise a first launch behind an unreachable edge ends with
 *    NO token at all (chat, sync and ingest all off), and nothing recovers
 *    it: the startup probe only checks the storage host, which is a
 *    different machine and answers fine. `withCrossServerReplay` opts the
 *    endpoints whose replay is provably safe back in.
 *  2. Walking the list must not ask the SAME host twice. Two regions that
 *    resolve to one base URL are one door, so a 503 would otherwise fan a
 *    single call out into two or three identical requests against a backend
 *    that is already failing — straight into the edge's rate-limit zone.
 *    `distinctByBaseUrl` collapses them.
 */

type RequestFn = (path: string, init?: RequestInit) => Promise<Response>

/**
 * The candidate list with duplicate doors removed: at most one region per
 * resolved base URL, in declared order. The preferred region is considered
 * first, so it always survives the collapse even when a region declared
 * earlier resolves to the same host (kit tracks outages and promotions by
 * the preferred id — dropping it would silently disable both).
 *
 * Deduplication is per-service, because two regions can share a host for one
 * service and differ for another; the caller passes the same `pickBaseUrl`
 * the failover client routes on.
 */
export function distinctByBaseUrl(
  servers: readonly CdnServer[],
  pickBaseUrl: (s: CdnServer) => string,
  preferredId: string
): CdnServer[] {
  const seen = new Set<string>()
  const out: CdnServer[] = []
  const take = (s: CdnServer): void => {
    const url = pickBaseUrl(s)
    if (seen.has(url)) return
    seen.add(url)
    out.push(s)
  }
  const preferred = servers.find((s) => s.id === preferredId)
  if (preferred) take(preferred)
  for (const s of servers) take(s)
  return out
}

export interface RegionFailoverOptions {
  /** Current region list, read per request (the registry list is runtime). */
  getServers: () => readonly CdnServer[]
  /** Currently-preferred region id, read per request. */
  getPreferredId: () => string
  /** Which of the region's URLs this client routes on. */
  pickBaseUrl: (s: CdnServer) => string
  /** Persist a fallback that was promoted after a long preferred outage. */
  onPromoteFallback?: (id: string) => void
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
}

/**
 * Whether a region's base URL for this service is something the WebView can
 * actually fetch.
 *
 * Not every region serves every door: `orchestratorBaseUrl` and friends are
 * optional (a published config.json predating the field omits it, and
 * `isValidRegion` deliberately does not require it), so `pickBaseUrl` returns
 * `""` for them. `joinUrl("", "/orchestrator/ingest/x")` is a PATH, and the
 * WebView resolves a path against its own origin — `capacitor://localhost` —
 * which answers 404. kit reads that 404 as non-transient, stops walking and
 * returns it, so a job that exists is reported "not found".
 *
 * A region that cannot serve this door is not a candidate at all.
 */
export function servesBaseUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** kit's failover client, fed a candidate list with duplicate doors removed. */
export function createRegionFailoverClient(opts: RegionFailoverOptions): FailoverClient {
  const candidates = (): CdnServer[] =>
    distinctByBaseUrl(
      opts.getServers().filter((s) => servesBaseUrl(opts.pickBaseUrl(s))),
      opts.pickBaseUrl,
      opts.getPreferredId()
    )
  const client = createFailoverClient<CdnServer>({ ...opts, getServers: candidates })

  // With no region serving this door there is nothing to fetch. Answering with
  // a scheme-less URL would hand the caller a local 404 dressed as the
  // backend's verdict; throwing lands in the same path a dead edge does, so the
  // UI reports a transient failure the user can retry.
  return {
    resolveUrl: (path) => (candidates().length === 0 ? "" : client.resolveUrl(path)),
    request: (path, init) => {
      if (candidates().length === 0) {
        return Promise.reject(new Error(`failover: no region serves ${path}`))
      }
      return client.request(path, init)
    },
  }
}

/**
 * Auth endpoints that may be re-issued against another edge.
 *
 * `/anonymous` is a device-keyed upsert — and it is the path that strands a
 * device with no identity at all when it fails. `/signin/google` and
 * `/signin/apple` resolve-or-create by (provider, subject): the same id
 * token verifies again and lands on the same user.
 *
 * Everything else stays on the preferred edge:
 *  - `/refresh` — single-use with rotation. A replay of a request that
 *    landed but whose response was lost turns a blip into a sign-out. The
 *    availability cost is nil: a refresh that reaches nobody is a network
 *    error, not a 401, so the client keeps its still-valid tokens and
 *    retries later.
 *  - `/signin/email/*` — the code is consumed on success and every verify
 *    burns one of a capped number of attempts.
 *  - `/signout`, `/account/delete` — destructive, and user-initiated with a
 *    visible error to retry.
 */
export function isReplayableAuthPath(path: string): boolean {
  return path === "/anonymous" || path === "/signin/google" || path === "/signin/apple"
}

/**
 * Mark the requests whose replay on another edge is safe. Paths that do not
 * match are passed through UNTOUCHED rather than flagged `false`, so a GET
 * keeps kit's method-derived fall-through.
 */
export function withCrossServerReplay(request: RequestFn, isReplayable: (path: string) => boolean) {
  return (path: string, init?: RequestInit): Promise<Response> => {
    if (!isReplayable(path)) return request(path, init)
    const replayable: FailoverRequestInit = { ...init, crossServerReplay: true }
    return request(path, replayable)
  }
}
