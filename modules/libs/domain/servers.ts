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
    name: "AWS (Global)",
    urlTemplate: "https://akds-lectorium.s3.us-east-1.amazonaws.com/{path}",
  },
  {
    id: "russia",
    name: "Yandex (RU)",
    urlTemplate: "https://akds-lectorium.storage.yandexcloud.net/{path}",
  },
]
