import { buildServerUrl, type CdnServer } from "@lib/domain/servers.js"
import type { IStoragePublicUrl } from "@ports/app/index.js"

export function useStoragePublicUrl(getActiveServer: () => CdnServer): IStoragePublicUrl {
  return {
    get: (path: string) => buildServerUrl(getActiveServer(), path),
  }
}
