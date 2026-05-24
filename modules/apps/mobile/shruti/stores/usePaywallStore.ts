import { defineStore } from "pinia"
import router from "@shruti/router/index.js"
import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"

/**
 * Single global entry point for the paywall. Pushes the dedicated
 * /tabs/subscription route — optionally with ?feature=… so the carousel
 * snaps to the slide that prompted the upsell. Kept as a store so
 * existing call sites like `usePaywallStore().requestOpen()` keep
 * compiling unchanged.
 */
export const usePaywallStore = defineStore("paywall", () => {
  function requestOpen(feature?: SubscriptionFeatureKey): void {
    void router.push({ name: "subscription", query: feature ? { feature } : {} })
  }
  return { requestOpen }
})
