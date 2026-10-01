import type { AddByUrlResult } from "@usecases/library/addByUrlResult.js"
import { addLibraryItemByUrl, type LectureHints } from "@usecases/library/addLibraryItemByUrl.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"

const EXTERNAL_IMPORT_LIMIT_KEY = "settings.externalImportLimit"
const DEFAULT_EXTERNAL_IMPORT_LIMIT = 10

export type AddLibraryItem = (url: string, hints?: LectureHints) => Promise<AddByUrlResult>

/**
 * Adding a lecture to the personal library, bound to the shelf, the
 * entitlement and the ingest API. The paywall store is loaded on demand, as
 * everywhere else: it carries the router.
 */
export function useAddLibraryItem(): AddLibraryItem {
  const app = useShruti()
  const library = useLibraryStore()
  const purchases = usePurchasesStore()
  const importLimit = app.preferences
    ? useConfig<number>(EXTERNAL_IMPORT_LIMIT_KEY, DEFAULT_EXTERNAL_IMPORT_LIMIT)
    : { value: DEFAULT_EXTERNAL_IMPORT_LIMIT }
  return (url, hints) =>
    addLibraryItemByUrl(url, hints, {
      ensurePro: () => purchases.ensurePro(),
      isPro: () => purchases.isSubscribed,
      externalItemCount: () => library.items.length,
      limit: () => importLimit.value,
      openPaywall: async () => {
        const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
      },
      library,
      ingest: app.ingestClient,
      requestSync,
    })
}
