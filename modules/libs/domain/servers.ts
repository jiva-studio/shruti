/**
 * CDN server list. The app probes these at startup and picks the first
 * reachable one. `{path}` is substituted with the storage key (full path
 * from the bucket root, including the `public/` prefix).
 *
 * After the move to self-hosted containers (P5.1 / P5.2 / P6.x), the
 * `shareAudioUrl` and `shareVideoUrl` endpoints both point at our
 * Caddy-fronted backend — `/share/audio/excerpts` and `/share/video/reels`
 * respectively. The reverse-proxy strips the prefix before the request
 * reaches the FastAPI / Express handlers.
 *
 * `urlTemplate` stays per-region — that's the public S3 bucket the
 * mobile client streams lecture audio from directly (AWS S3 us-east-1
 * for `global`, Yandex Object Storage for `russia`). Until a Russia VPS
 * exists, both regions' share-* URLs share the same Cloud Provider box; the
 * Russia entry will get its own host name once that lands.
 */

export interface CdnServer {
  readonly id: string
  readonly name: string
  readonly urlTemplate: string
  readonly shareAudioUrl: string
  readonly shareVideoUrl: string
  /** Base URL of the shruti auth service for this region, e.g.
   *  `https://<host>/auth`. Read at call time via the composition
   *  root's `activeServer` ref so a region flip routes auth traffic
   *  to the new backend without an app restart. */
  readonly authBaseUrl: string
  /** Base URL of the shruti chat service for this region. Same
   *  per-region lazy-resolution pattern as `authBaseUrl` — the chat
   *  HTTP client reads it through a getter, not at module import time. */
  readonly chatBaseUrl: string
}

// Single host until we stand up a Russia VPS; sslip.io resolves
// <ip-dashed>.sslip.io → 31.220.80.248 without us owning a domain.
const HOST = "https://api.shruti.local"

export const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://cdn-s3.shruti.local/{path}",
    shareAudioUrl: `${HOST}/share/audio/excerpts`,
    shareVideoUrl: `${HOST}/share/video/reels`,
    authBaseUrl: `${HOST}/auth`,
    chatBaseUrl: HOST,
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://cdn-ru.shruti.local/{path}",
    // TODO: replace with a Russia-side host once the RU VPS is live. Until
    // then Russia users hit the same backend as Global; their CDN reads
    // (urlTemplate above) still resolve to Yandex Object Storage so big
    // assets stay close, but share-* / auth / chat round-trip through Germany.
    shareAudioUrl: `${HOST}/share/audio/excerpts`,
    shareVideoUrl: `${HOST}/share/video/reels`,
    authBaseUrl: `${HOST}/auth`,
    chatBaseUrl: HOST,
  },
]

/**
 * Canonical `{path}` substitution. Use this anywhere a full URL has to be
 * assembled from a server template — `IStoragePublicUrl.get()` and the
 * startup probe both route through here so the rule "paths are already
 * full bucket keys; the client only swaps templates" stays in one place.
 */
export function buildServerUrl(server: CdnServer, path: string): string {
  return server.urlTemplate.replace("{path}", path)
}
