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
 * `urlTemplate` stays per-region — that's the public bucket/CDN the
 * mobile client streams lecture audio from and pulls the content DB from.
 * `global` now resolves to Bunny CDN (`cdn.shruti.local`), the
 * primary origin catalog publishes reach; `russia` to Yandex Object
 * Storage; the old AWS S3 bucket is kept only as the `legacy` region so
 * installs still pinned to it can read a config.json and migrate off.
 */

import type { CdnServer as KitCdnServer } from "@kit/servers"
export { buildServerUrl } from "@kit/servers"

/**
 * Public web app (https://shruti.app). Shareable lecture deep-links
 * resolve to `${WEB_APP_BASE_URL}/<locale>/app/<slug>`. Region-independent —
 * a shared link is a public URL the recipient opens from anywhere — so it is
 * a flat constant, not a per-region CdnServer field.
 */
export const WEB_APP_BASE_URL = "https://shruti.app"

/**
 * UI locales the web app serves, as its URL prefixes (lowercase). The deep-
 * link opens in the user's app UI language when the web has a matching
 * locale, else WEB_APP_DEFAULT_LOCALE. Mobile UI codes are normalised to this
 * casing (`sr-Latn` → `sr-latn`). Keep in sync with the web's astro i18n
 * `locales` as more languages ship there.
 */
export const WEB_APP_LOCALES: readonly string[] = ["en", "ru", "uk", "sr-latn", "sr-cyrl"]

/** Fallback locale when the user's UI language has no web page. */
export const WEB_APP_DEFAULT_LOCALE = "en"

/**
 * Shruti's region descriptor. Extends kit's generic `CdnServer`
 * ({ id, name, urlTemplate }) with the app-specific per-region service
 * endpoints. The probe + failover machinery lives in `@kit/servers` and
 * operates on the generic base; these extra fields are read only by app
 * code (`pickBaseUrl` callbacks, the chat/auth HTTP clients).
 */
export interface CdnServer extends KitCdnServer {
  readonly shareAudioUrl: string
  readonly shareVideoUrl: string
  /** Base URL of the share-transcript service for this region, e.g.
   *  `https://<host>/share/transcripts`. The client appends the output
   *  format as a path segment (`/pdf` today); Caddy strips the
   *  `/share/transcripts` prefix before the app sees `/pdf`.
   *
   *  Optional: a published `config.json` predating this field omits it;
   *  the composition root then derives it from `chatBaseUrl` (the
   *  share-* routes live behind the same Caddy as chat). */
  readonly shareTranscriptUrl?: string
  /** Base URL of the shruti auth service for this region, e.g.
   *  `https://<host>/auth`. Read at call time via the composition
   *  root's `activeServer` ref so a region flip routes auth traffic
   *  to the new backend without an app restart. */
  readonly authBaseUrl: string
  /** Base URL of the shruti chat service for this region. Same
   *  per-region lazy-resolution pattern as `authBaseUrl` — the chat
   *  HTTP client reads it through a getter, not at module import time. */
  readonly chatBaseUrl: string
  /** Base URL of the shruti `profile` device↔server sync service for
   *  this region. The sync HTTP client appends `/profile/sync/{pull,push,
   *  cursor}` to it. `profile` is origin-only, reached over the same Caddy
   *  edge as chat but on its own `/profile/*` routes — a distinct service,
   *  not chat. Read through a getter at call time, like `chatBaseUrl`, so a
   *  region flip routes sync traffic to the new backend without a restart.
   *
   *  Optional so a `config.json` predating the `profile` service stays valid.
   *  When absent the sync engine stays off — a published config carries this
   *  field before sync is enabled for the region. */
  readonly profileBaseUrl?: string
  /** Base URL of the shruti `orchestrator` ingest control plane for this
   *  region. The ingest HTTP client appends `/orchestrator/ingest[/{id}]` to it.
   *  The orchestrator is origin-only, reached over the same Caddy edge as chat
   *  but on its own `/orchestrator/*` routes — a distinct service. Read through a
   *  getter at call time, like `chatBaseUrl`, so a region flip routes ingest
   *  traffic to the new backend without a restart.
   *
   *  Optional so a `config.json` predating the ingest API stays valid. When
   *  absent the client falls back to the (retired) chat add-to-library path. */
  readonly orchestratorBaseUrl?: string
  /** Base URL of the `discovery` service — the index of lectures published on
   *  other archives. The client appends `/discovery/search` to it. Origin-only
   *  and reached over the same Caddy edge as chat, on the single published
   *  `/discovery/search` route; the rest of that service stays internal.
   *
   *  Optional so a `config.json` predating it stays valid. When absent the
   *  composition root derives it from `chatBaseUrl` — same edge, same host —
   *  exactly as it does for `shareTranscriptUrl`. */
  readonly discoveryBaseUrl?: string
}

// sslip.io resolves <ip-dashed>.sslip.io → the literal IP without us
// owning a domain. Lets Caddy auto-provision Let's Encrypt certs on
// both Cloud Provider (global) and Dedicated Host (russia) with zero DNS work.
const HOST = "https://api.shruti.local"
const HOST_RU = "https://ru.shruti.local"

export const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://cdn.shruti.local/{path}",
    shareAudioUrl: `${HOST}/share/audio/excerpts`,
    shareVideoUrl: `${HOST}/share/video/reels`,
    shareTranscriptUrl: `${HOST}/share/transcripts`,
    authBaseUrl: `${HOST}/auth`,
    chatBaseUrl: HOST,
    profileBaseUrl: HOST,
    orchestratorBaseUrl: HOST,
    discoveryBaseUrl: HOST,
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://cdn-ru.shruti.local/{path}",
    // Auth + chat live on the RU VPS (Dedicated Host, Moscow); CDN reads
    // resolve to Yandex Object Storage independently of the regional
    // service host. share-audio + share-video also run locally on the
    // RU host (under the `proxy` compose profile + dedicated reverse_proxy
    // routes in Caddyfile), uploading to the Yandex bucket — so RU users
    // hit RU containers end-to-end and excerpts/reels stay on data-resident
    // storage. The global host's share-* containers serve everyone else.
    shareAudioUrl: `${HOST_RU}/share/audio/excerpts`,
    shareVideoUrl: `${HOST_RU}/share/video/reels`,
    shareTranscriptUrl: `${HOST_RU}/share/transcripts`,
    authBaseUrl: `${HOST_RU}/auth`,
    chatBaseUrl: HOST_RU,
    profileBaseUrl: HOST_RU,
    orchestratorBaseUrl: HOST_RU,
    discoveryBaseUrl: HOST_RU,
  },
  {
    // The former `global` origin — the AWS S3 bucket. Retired as the
    // primary (global now points at Bunny) but kept so installs still
    // pinned to S3 can fetch a config.json, learn the new region list,
    // and migrate off. Its service endpoints stay on the same host as
    // global — only the storage `urlTemplate` differs.
    id: "legacy",
    name: "Legacy",
    urlTemplate: "https://cdn-s3.shruti.local/{path}",
    shareAudioUrl: `${HOST}/share/audio/excerpts`,
    shareVideoUrl: `${HOST}/share/video/reels`,
    shareTranscriptUrl: `${HOST}/share/transcripts`,
    authBaseUrl: `${HOST}/auth`,
    chatBaseUrl: HOST,
    profileBaseUrl: HOST,
    orchestratorBaseUrl: HOST,
    discoveryBaseUrl: HOST,
  },
]
