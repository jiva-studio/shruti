import { defineStore } from "pinia"
import { ref } from "vue"

/**
 * Global open/close gate for the subscription paywall. Multiple call
 * sites (Settings, Smart Library, Studio, …) all share one dialog
 * instance mounted at the tabs layout — they don't carry their own
 * `open` ref, they just call `paywall.requestOpen()` when they need it.
 *
 * Keeping this as a store (not a composable with module-level state)
 * lets it survive Vue's HMR cleanly and stays consistent with the
 * `usePurchasesStore` / `useShareJobStore` pattern already in use.
 */
export const usePaywallStore = defineStore("paywall", () => {
  const open = ref<boolean>(false)

  function requestOpen(): void {
    open.value = true
  }

  function close(): void {
    open.value = false
  }

  return { open, requestOpen, close }
})
