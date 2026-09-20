import { buildServerUrl, type CdnServer } from "../../servers/index.js"
import type { IStoragePublicUrl } from "./storagePublicUrl.js"

/**
 * {@link IStoragePublicUrl} backed by the active CDN server's URL
 * template. The active server is read lazily on each call via
 * `getActiveServer`, so the resolver always reflects the current
 * region selection without needing to be re-created on change.
 */
export function useStoragePublicUrl(
  getActiveServer: () => Pick<CdnServer, "urlTemplate">
): IStoragePublicUrl {
  return {
    get: (path: string) => buildServerUrl(getActiveServer(), path),
  }
}
