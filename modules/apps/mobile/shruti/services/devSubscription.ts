import { ref } from "vue"

/**
 * Subscription override, settable through the debug bridge (the "dev
 * controller") and by the e2e suite before boot. Lets us flip the app
 * between Pro and Free so paywalled surfaces — including the onboarding paywall
 * — are reachable without a real RevenueCat purchase (RC isn't even available
 * on web). NEVER grants Pro on a production build; a real purchase always wins.
 *
 * - "default" — the build's natural behaviour (dev/preview ⇒ Pro).
 * - "pro"     — force subscribed (dev/preview and test builds only).
 * - "free"    — force the non-subscribed paywall.
 */
export type DevSubscriptionOverride = "default" | "pro" | "free"

const KEY = "CapacitorStorage.dev.subscriptionOverride"
const LEGACY_FREE = "CapacitorStorage.e2e.forceFreeTier"

declare const __BUILD_ID__: string
declare const __E2E_BUILD__: boolean

/**
 * True on a dev build, decided at BUILD time.
 *
 * It used to also return true for any hostname ending in `.pages.dev`, which
 * made every Cloudflare preview deployment a fully unlocked Pro build. A
 * preview URL is derived from the PR number, so with a public repository that
 * is an unlock anyone can reach. A preview that needs the paywalled surfaces
 * opts in at build time instead, by building with `BUILD_ID=dev` or
 * `SHRUTI_E2E_BUILD=1`.
 */
export const isDevBuild = __BUILD_ID__ === "dev"

/**
 * Builds where the override may grant Pro at all: dev/preview, plus a build
 * made for the automated tests — `__E2E_BUILD__`, compiled in from
 * `SHRUTI_E2E_BUILD=1` and false everywhere else, including in every release
 * artifact. This is the level that decides whether the seam EXISTS; which tier
 * it then selects is chosen at runtime, per test, by the override below.
 *
 * The dev build's own default is unchanged — the two are ORed, not replaced.
 */
export const isSubscriptionOverridable = isDevBuild || __E2E_BUILD__

/**
 * What the override says about the entitlement, on THIS build.
 *
 * "free" applies everywhere — it can only take Pro away, and a build that
 * refused to be downgraded would make the paywall untestable. "pro" needs a
 * build that opted in, and grants nothing on any other. Callers apply this only
 * AFTER a real purchase has been ruled out, so a subscriber is never affected.
 */
export function subscriptionFromOverride(
  override: DevSubscriptionOverride,
  overridable: boolean = isSubscriptionOverridable,
  natural: boolean = isDevBuild
): boolean {
  if (override === "free") return false
  if (override === "pro") return overridable
  return natural
}

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
