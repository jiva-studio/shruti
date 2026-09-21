import { defineStore } from "pinia"
import { computed, ref, type Ref, type WatchStopHandle } from "vue"
import { useShruti } from "@shruti/shruti.js"
import type { CustomerState, IPurchases, PurchasePackage } from "@ports/app/purchases.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { createPurchasesBootstrap } from "@shruti/stores/purchases/bootstrap.js"
import { createEntitlementState } from "@shruti/stores/purchases/entitlementState.js"
import { watchRcIdentity } from "@shruti/stores/purchases/identityWatch.js"
import { ensureProAccess } from "@shruti/stores/purchases/proGate.js"
import { tierDisagrees, type RcIdentityDeps } from "@shruti/stores/purchases/rcIdentity.js"
import {
  createReconcileTracker,
  RECONCILE_BUDGET_MS,
} from "@shruti/stores/purchases/reconcile.js"
import {
  devSubscriptionOverride,
  subscriptionFromOverride,
} from "@shruti/services/devSubscription.js"
import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"

/**
 * Reactive view over RevenueCat. State here is derived live from the SDK —
 * `getCustomerInfo` / `purchasePackage` / `restorePurchases` plus the
 * `addCustomerInfoUpdateListener` push channel. The reinstall flow relies on
 * `restore()` rebinding the install to the Apple / Google account's history.
 */
export const usePurchasesStore = defineStore("purchases", () => {
  const packages = ref<PurchasePackage[]>([])
  const loading = ref(false)
  const purchasing = ref(false)
  const restoring = ref(false)
  const ready = ref(false)
  const entitlement = createEntitlementState()
  const { activePackageId, managementUrl, appUserId } = entitlement
  const reconcile = createReconcileTracker()
  const { reconciling, reconcileOverdue } = reconcile
  let stopAuthWatch: WatchStopHandle | undefined

  const available = computed(() => useShruti().purchases.available)
  // Dev/preview builds unlock Pro by default so paywalled surfaces are
  // explorable without a real purchase (RC isn't available on web at all).
  // A real purchase always wins; the override never grants Pro on prod.
  const isSubscribed = computed(() => {
    if (activePackageId.value !== undefined) return true
    // Off-store build has no RevenueCat — Pro is bought on the website and
    // mirrored into the auth `tier` claim.
    if (__OFFSTORE_BUILD__) return useAuthStore().isPro
    return subscriptionFromOverride(devSubscriptionOverride.value)
  })

  /**
   * Waiting longer buys nothing: the first customer fetch landed and the
   * identity reconcile either settled or blew its budget. Says nothing about
   * WHICH answer we have. Surfaces that must eventually commit to a branch
   * read this; `resolved` is for the ones that may keep waiting.
   */
  const settled = computed(() => ready.value && !reconciling.value)

  /**
   * The subscribed answer is FINAL. Every surface that gates a Pro feature or
   * opens the paywall reads this rather than `ready` — a returning subscriber
   * with no local cache is `ready` long before RevenueCat says who they are.
   */
  const resolved = computed(() => settled.value && !reconcileOverdue.value)

  function rcDeps(): RcIdentityDeps {
    const auth = useAuthStore()
    return {
      purchases: useShruti().purchases,
      applyState: entitlement.apply,
      refreshTokens: () => auth.refreshTokens(),
    }
  }

  const bootstrap = createPurchasesBootstrap({
    purchases: () => useShruti().purchases,
    packages,
    entitlement,
    loading,
    ready,
    onCustomerInfo,
    registerAuthWatch,
  })

  /**
   * RC's push channel. The JWT `tier` claim is frozen at issue time, so
   * without an explicit refresh a server-side flip wouldn't reach the chat
   * rate-limiter until the next natural rotation (~15 min).
   */
  function onCustomerInfo(s: CustomerState): void {
    entitlement.apply(s)
    const auth = useAuthStore()
    if (tierDisagrees(s.activePackageId !== undefined, auth.rawTier)) {
      void auth.refreshTokens()
    }
  }

  function registerAuthWatch(): void {
    if (stopAuthWatch) return
    const auth = useAuthStore()
    stopAuthWatch = watchRcIdentity({
      identity: () => ({ userId: auth.userId, anonymous: auth.anonymous }),
      rc: rcDeps,
      track: reconcile.track,
      onAccountSwitch: () => void entitlement.forget({ managementUrl: "keep" }),
    })
  }

  /**
   * Let an in-flight RC.logIn from a just-now signin land first, or the
   * receipt attaches to the anonymous app_user_id. Afterwards the server-side
   * tier may still be catching up with the receipts RC was just handed, and a
   * bare token refresh would leave the 5-minute /auth/me cache as the sign-in
   * stamped it — so the composer would send as tier=free seconds after payment.
   */
  async function runTransaction(
    flag: Ref<boolean>,
    run: (purchases: IPurchases) => Promise<CustomerState>
  ): Promise<void> {
    const purchases = useShruti().purchases
    if (!purchases.available) return
    flag.value = true
    try {
      await reconcile.wait(5000)
      entitlement.apply(await run(purchases))
      useAuthStore().invalidateAndSyncTier()
    } finally {
      flag.value = false
    }
  }

  function purchase(packageId: string): Promise<void> {
    return runTransaction(purchasing, (p) => p.purchase(packageId))
  }

  function restore(): Promise<void> {
    return runTransaction(restoring, (p) => p.restore())
  }

  function ensurePro(feature?: SubscriptionFeatureKey): Promise<boolean> {
    return ensureProAccess(
      {
        isSubscribed: () => isSubscribed.value,
        ready: () => ready.value,
        init: bootstrap.init,
        reconcileOverdue: () => reconcileOverdue.value,
        waitForReconcile: reconcile.wait,
        budgetMs: RECONCILE_BUDGET_MS,
      },
      feature
    )
  }

  /**
   * Explicit RC SDK sign-out, called before the session flips so the identity
   * watcher's anonymous logIn doesn't race it. The entitlement is dropped up
   * front — in memory and on disk, and before the availability guard — so
   * neither a flaky SDK logOut nor a build without RC can leave the departing
   * account's Pro behind.
   */
  async function logOut(): Promise<void> {
    await entitlement.forget({ managementUrl: "clear" })
    if (!available.value) return
    try {
      entitlement.apply(await useShruti().purchases.logOut())
    } catch (e) {
      console.warn("[purchases] logOut failed", e)
    }
  }

  function dispose(): void {
    bootstrap.stopListeners()
    stopAuthWatch?.()
    stopAuthWatch = undefined
    reconcile.reset()
    ready.value = false
  }

  return {
    packages,
    activePackageId,
    managementUrl,
    appUserId,
    loading,
    purchasing,
    restoring,
    ready,
    reconciling,
    reconcileOverdue,
    settled,
    resolved,
    available,
    isSubscribed,
    init: bootstrap.init,
    ensurePro,
    purchase,
    restore,
    refresh: bootstrap.refresh,
    logOut,
    dispose,
  }
})
