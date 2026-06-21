import { ref } from "vue"

/**
 * Dev-only subscription override, settable from the hidden Settings → Debug
 * menu (the "dev controller"). Lets us flip the app between Pro and Free on a
 * dev/preview build so paywalled surfaces — including the onboarding paywall —
 * are reviewable without a real RevenueCat purchase (RC isn't even available on
 * web). NEVER grants Pro on a production build; a real purchase always wins.
 *
 * - "default" — the build's natural behaviour (dev/preview ⇒ Pro).
 * - "pro"     — force subscribed (dev/preview only).
 * - "free"    — force the non-subscribed paywall.
 */
export type DevSubscriptionOverride = "default" | "pro" | "free"

const KEY = "CapacitorStorage.dev.subscriptionOverride"
const LEGACY_FREE = "CapacitorStorage.e2e.forceFreeTier"

declare const __BUILD_ID__: string

/** True on dev / Cloudflare-preview builds — the only place an override applies. */
export const isDevBuild =
  __BUILD_ID__ === "dev" ||
  (typeof window !== "undefined" && window.location.hostname.endsWith(".pages.dev"))

function read(): DevSubscriptionOverride {
  if (typeof localStorage === "undefined") return "default"
  // The e2e suite's NON-pro escape hatch maps onto "free".
  if (localStorage.getItem(LEGACY_FREE) === "1") return "free"
  const v = localStorage.getItem(KEY)
  return v === "pro" || v === "free" ? v : "default"
}

/** Reactive so the purchases store + paywall react the instant it changes. */
export const devSubscriptionOverride = ref<DevSubscriptionOverride>(read())

export function setDevSubscriptionOverride(value: DevSubscriptionOverride): void {
  devSubscriptionOverride.value = value
  try {
    if (value === "default") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, value)
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
}
