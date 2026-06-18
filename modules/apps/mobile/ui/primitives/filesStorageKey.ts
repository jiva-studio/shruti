import type { InjectionKey } from "vue"
import type { IRemoteFilesStorage } from "@kit/infra"

/**
 * Provided by the composition root (App.vue) so UI can resolve cached image
 * URLs (CachedImage / AuthorAvatar) without importing the composition root.
 */
export const FILES_STORAGE_KEY: InjectionKey<IRemoteFilesStorage> = Symbol("filesStorage")

/**
 * Last-resort CDN region failover for a failed asset url, provided by the
 * composition root. `CachedImage` calls it only after its same-region retries
 * and raw-url fallback have failed; it returns a locally-usable url served from
 * another region (and promotes that region), or null if none can. Typed inline
 * so the UI layer stays free of app-layer imports.
 */
export const ASSET_FAILOVER_KEY: InjectionKey<(failedUrl: string) => Promise<string | null>> =
  Symbol("assetFailover")
