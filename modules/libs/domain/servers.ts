/**
 * CDN server list. The app probes these at startup and picks the first
 * reachable one. `{path}` is substituted with the storage key (full path
 * from the bucket root, including the `public/` prefix).
 */

export interface CdnServer {
  readonly id: string
  readonly name: string
  readonly urlTemplate: string
}

export const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://akds-lectorium.s3.us-east-1.amazonaws.com/{path}",
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://akds-lectorium.storage.yandexcloud.net/{path}",
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
