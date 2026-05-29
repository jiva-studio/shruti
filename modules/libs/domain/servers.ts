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
  /** Base URL of the lectorium auth service for this region, e.g.
   *  `https://<host>/auth`. Read at call time via the composition
   *  root's `activeServer` ref so a region flip routes auth traffic
   *  to the new backend without an app restart. */
  readonly authBaseUrl: string
  /** Base URL of the lectorium chat service for this region. Same
   *  per-region lazy-resolution pattern as `authBaseUrl` — the chat
   *  HTTP client reads it through a getter, not at module import time. */
  readonly chatBaseUrl: string
}

// sslip.io resolves <ip-dashed>.sslip.io → the literal IP without us
// owning a domain. Lets Caddy auto-provision Let's Encrypt certs on
// both Cloud Provider (global) and Dedicated Host (russia) with zero DNS work.
const HOST = "https://api.shruti.local"
const HOST_RU = "https://62-109-31-177.sslip.io"

export const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://akds-lectorium.s3.us-east-1.amazonaws.com/{path}",
    shareAudioUrl: `${HOST}/share/audio/excerpts`,
    shareVideoUrl: `${HOST}/share/video/reels`,
    authBaseUrl: `${HOST}/auth`,
    chatBaseUrl: HOST,
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://akds-lectorium.storage.yandexcloud.net/{path}",
    // Auth + chat live on the RU VPS (Dedicated Host, Moscow); CDN reads
    // resolve to Yandex Object Storage independently of the regional
    // service host. share-audio + share-video also run locally on the
    // RU host (under the `proxy` compose profile + dedicated reverse_proxy
    // routes in Caddyfile), uploading to the Yandex bucket — so RU users
    // hit RU containers end-to-end and excerpts/reels stay on data-resident
    // storage. The global host's share-* containers serve everyone else.
    shareAudioUrl: `${HOST_RU}/share/audio/excerpts`,
    shareVideoUrl: `${HOST_RU}/share/video/reels`,
    authBaseUrl: `${HOST_RU}/auth`,
    chatBaseUrl: HOST_RU,
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
