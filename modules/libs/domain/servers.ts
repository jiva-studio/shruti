/**
 * CDN server list. The app probes these at startup and picks the first
 * reachable one. `{path}` is substituted with the storage key (full path
 * from the bucket root, including the `public/` prefix).
 *
 * `shareAudioUrl` is the per-region endpoint of the share-audio cutter
 * function (AWS Lambda HTTP API for `global`, Yandex Cloud Function for
 * `russia`). Both return the same `public/shares/audio/<id>.mp3` URL on
 * the underlying S3 bucket; the consumer only needs to pick the
 * geographically-closer compute endpoint.
 */

export interface CdnServer {
  readonly id: string
  readonly name: string
  readonly urlTemplate: string
  readonly shareAudioUrl: string
}

export const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://cdn-s3.shruti.local/{path}",
    shareAudioUrl: "https://7hl2sboutd.execute-api.us-east-1.amazonaws.com/excerpts",
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://cdn-ru.shruti.local/{path}",
    shareAudioUrl: "https://functions.yandexcloud.net/d4er0qjat23q6ic6dt0p",
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
