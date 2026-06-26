import { defineStore } from "pinia"
import router from "@shruti/router/index.js"
import { currentLocale } from "@shruti/i18n/index.js"
import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"

// The off-store build has no in-app purchase — Pro is sold on the website —
// so every upsell CTA opens the locale-aware subscribe page in the system
// browser instead of the in-app paywall route. Only the website's own
// locales have a /subscribe page; anything else falls back to English.
const WEBSITE_BASE = "https://shruti.app"
const WEBSITE_LOCALES = new Set(["en", "ru", "uk", "sr-latn", "sr-cyrl"])

function websiteSubscribeUrl(): string {
  const locale = String(currentLocale()).toLowerCase()
  const lang = WEBSITE_LOCALES.has(locale) ? locale : "en"
  return `${WEBSITE_BASE}/${lang}/subscribe`
}

/**
 * Single global entry point for the paywall. Pushes the dedicated
 * /tabs/subscription route — optionally with ?feature=… so the carousel
 * snaps to the slide that prompted the upsell. Kept as a store so
 * existing call sites like `usePaywallStore().requestOpen()` keep
 * compiling unchanged. In the off-store build it instead opens the website
 * payment page.
 */
export const usePaywallStore = defineStore("paywall", () => {
  function requestOpen(feature?: SubscriptionFeatureKey): void {
    if (__OFFSTORE_BUILD__) {
      // Capacitor's WebView routes window.open to the system browser.
      window.open(websiteSubscribeUrl(), "_blank")
      return
    }
    void router.push({ name: "subscription", query: feature ? { feature } : {} })
  }
  return { requestOpen }
})
