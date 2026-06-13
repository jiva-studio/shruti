import router from "@lectorium/router/index.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import {
  useStudioHandoffStore,
  type StudioHandoff,
} from "@lectorium/stores/useStudioHandoffStore.js"

/**
 * Pro-gated hand-off into the Studio editor. Non-subscribers get the paywall
 * instead of navigating; the editor re-checks the gate on mount, so a stale
 * "subscribed" cache can't slip through. The pending payload is parked in the
 * store (not router state) because Ionic drops `history.state` when navigating
 * out of a dismissing action sheet.
 */
export function useOpenInStudio(): { openInStudio: (pending: StudioHandoff) => void } {
  const purchases = usePurchasesStore()
  const paywall = usePaywallStore()
  const studioHandoff = useStudioHandoffStore()

  function openInStudio(pending: StudioHandoff): void {
    if (!purchases.isSubscribed) {
      paywall.requestOpen("notesStudio")
      return
    }
    studioHandoff.setPending(pending)
    void router.push("/tabs/studio")
  }

  return { openInStudio }
}
