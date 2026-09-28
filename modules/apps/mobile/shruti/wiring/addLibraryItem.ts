import type { AddByUrlResult } from "@usecases/library/addByUrlResult.js"
import { addLibraryItemByUrl, type LectureHints } from "@usecases/library/addLibraryItemByUrl.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"

export type AddLibraryItem = (url: string, hints?: LectureHints) => Promise<AddByUrlResult>

/**
 * Adding a lecture to the personal library, bound to the shelf, the
 * entitlement and the ingest API. The paywall store is loaded on demand, as
 * everywhere else: it carries the router.
 */
export function useAddLibraryItem(): AddLibraryItem {
  const app = useShruti()
  const library = useLibraryStore()
  return (url, hints) =>
    addLibraryItemByUrl(url, hints, {
      ensurePro: () => usePurchasesStore().ensurePro(),
      openPaywall: async () => {
        const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
      },
      library,
      ingest: app.ingestClient,
      requestSync,
    })
}
