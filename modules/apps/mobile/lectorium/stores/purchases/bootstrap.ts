import { App, type AppState } from "@capacitor/app"
import type { Ref } from "vue"
import type { CustomerState, IPurchases, PurchasePackage } from "@ports/app/purchases.js"
import type { EntitlementState } from "@lectorium/stores/purchases/entitlementState.js"
import { devMockPackages, isEmptyOfferingsError } from "@lectorium/stores/purchases/offerings.js"
import { isSubscriptionOverridable } from "@lectorium/services/devSubscription.js"
import { reportWarning } from "@lectorium/services/monitoring/reportError.js"

export interface PurchasesBootstrapDeps {
  /** Resolved per call — the port is created after the store. */
  readonly purchases: () => IPurchases
  readonly packages: Ref<PurchasePackage[]>
  readonly entitlement: EntitlementState
  readonly loading: Ref<boolean>
  readonly ready: Ref<boolean>
  readonly onCustomerInfo: (s: CustomerState) => void
  readonly registerAuthWatch: () => void
}

export interface PurchasesBootstrap {
  init(): Promise<void>
  refresh(): Promise<void>
  /** Drop the listeners `init` registered. */
  stopListeners(): void
}

/** Brings the RC SDK up and keeps its answer fresh; owns the listeners it registers. */
export function createPurchasesBootstrap(deps: PurchasesBootstrapDeps): PurchasesBootstrap {
  let unsubscribe: (() => void) | undefined
  let resumeHandle: { remove(): Promise<void> } | undefined
  // Single-flight: app bootstrap and a paywall mount can both call init() in
  // the same frame, and the `ready` guard only flips AFTER the awaits — so
  // both would otherwise register duplicate listeners.
  let initPromise: Promise<void> | null = null

  function init(): Promise<void> {
    if (deps.ready.value) return Promise.resolve()
    if (initPromise) return initPromise
    initPromise = doInit().finally(() => {
      initPromise = null
    })
    return initPromise
  }

  async function doInit(): Promise<void> {
    const purchases = deps.purchases()
    if (!purchases.available) {
      // Seed sample packages on dev/preview and test builds so the paywall
      // renders real plan cards. Production web keeps an empty list.
      if (isSubscriptionOverridable) deps.packages.value = devMockPackages()
      deps.ready.value = true
      return
    }
    deps.loading.value = true
    try {
      // Expose the cached entitlement before the SDK round-trip so a returning
      // subscriber doesn't flicker through the free state.
      await deps.entitlement.hydrate()
      await purchases.configure()
      await firstFetch(purchases)
      unsubscribe = purchases.onCustomerInfoChanged(deps.onCustomerInfo)
      resumeHandle = await registerResumeRefresh()
    } finally {
      deps.loading.value = false
      // The watcher is the session's only route back to a correct entitlement
      // after an identity change; registering it inside the try meant a
      // `configure()` throw left the session without one.
      try {
        deps.registerAuthWatch()
      } catch (e) {
        console.warn("[purchases] auth watch registration failed", e)
      }
      // `ready` means "the first answer has landed", and a failure IS an
      // answer — init() is one-shot, so a throw here must not leave the
      // paywall on its loading string for the rest of the session.
      deps.ready.value = true
    }
  }

  /**
   * Offerings and customer state in one round, tolerating a transient failure
   * of either so the listeners still register. A failed listPackages just
   * yields no plan cards; a missing state leaves the cached entitlement in
   * place, since only a successful fetch may downgrade it.
   */
  async function firstFetch(purchases: IPurchases): Promise<void> {
    const [packages, state] = await Promise.all([
      purchases.listPackages().catch((e) => {
        if (isEmptyOfferingsError(e)) reportWarning("purchases", e, { at: "init" })
        return [] as PurchasePackage[]
      }),
      purchases.getCustomerState().catch(() => undefined),
    ])
    deps.packages.value = packages
    if (state) deps.entitlement.apply(state)
  }

  /**
   * Re-fetch on foreground: for sandbox and late-renewal cases RC's push
   * channel doesn't notify until the next explicit call. A failed registration
   * is survivable and must not abort the rest of init, which has no retry.
   */
  async function registerResumeRefresh(): Promise<{ remove(): Promise<void> } | undefined> {
    try {
      return await App.addListener("appStateChange", (state: AppState) => {
        if (state.isActive) void refresh()
      })
    } catch (e) {
      console.warn("[purchases] appStateChange listener registration failed", e)
      return undefined
    }
  }

  async function refresh(): Promise<void> {
    const purchases = deps.purchases()
    if (!purchases.available) return
    // Self-heal an empty paywall: a transient failure during init() leaves the
    // package list empty, and this runs on every resume. A genuinely empty
    // offering set just re-fetches empty.
    if (deps.packages.value.length === 0) {
      await purchases
        .listPackages()
        .then((p) => {
          deps.packages.value = p
        })
        .catch((e) => {
          if (isEmptyOfferingsError(e)) reportWarning("purchases", e, { at: "refresh" })
        })
    }
    try {
      deps.entitlement.apply(await purchases.getCustomerState())
    } catch (e) {
      console.error("[purchases] refresh failed:", e)
    }
  }

  function stopListeners(): void {
    unsubscribe?.()
    unsubscribe = undefined
    void resumeHandle?.remove()
    resumeHandle = undefined
  }

  return { init, refresh, stopListeners }
}
