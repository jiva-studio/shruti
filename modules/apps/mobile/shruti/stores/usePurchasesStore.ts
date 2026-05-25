import { defineStore } from "pinia"
import { computed, ref, watch, type WatchStopHandle } from "vue"
import { App, type AppState } from "@capacitor/app"
import { useShruti } from "@shruti/shruti.js"
import type { CustomerState, PurchasePackage } from "@ports/app/purchases.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"

/**
 * Reactive view over RevenueCat. State here is derived live from the
 * SDK — `getCustomerInfo` / `purchasePackage` / `restorePurchases`
 * plus the `addCustomerInfoUpdateListener` push channel. Nothing about
 * subscription state is persisted by the app; the reinstall flow
 * relies on `restore()` rebinding the install to the Apple / Google
 * account's purchase history.
 */
export const usePurchasesStore = defineStore("purchases", () => {
  const packages = ref<PurchasePackage[]>([])
  const activePackageId = ref<string | undefined>(undefined)
  const managementUrl = ref<string | undefined>(undefined)
  const appUserId = ref<string | undefined>(undefined)
  const loading = ref(false)
  const purchasing = ref(false)
  const restoring = ref(false)
  const ready = ref(false)
  let unsubscribe: (() => void) | undefined
  let resumeHandle: { remove(): Promise<void> } | undefined
  let stopAuthWatch: WatchStopHandle | undefined

  const available = computed(() => useShruti().purchases.available)
  // Dev-build override: treat every dev build as Pro so we can test
  // paywalled surfaces (Smart Library, Notes Studio, etc.) without a
  // real RevenueCat purchase. `__BUILD_ID__` is "dev" only when the
  // CI doesn't set `BUILD_ID` env var — production builds always
  // override it with the version+hash.
  //
  // Side effect: the `is_subscribed: false` eligibility predicate in
  // `smart_library_hint` won't hold on dev builds, so the autonomous
  // tutorial for it won't fire on dev devices. That's the trade-off —
  // pick "Pro is unlocked" over "non-Pro flows are reproducible".
  const isSubscribed = computed(() => __BUILD_ID__ === "dev" || activePackageId.value !== undefined)

  function applyState(s: CustomerState): void {
    activePackageId.value = s.activePackageId
    managementUrl.value = s.managementUrl
    appUserId.value = s.appUserId
  }

  async function refresh(): Promise<void> {
    const purchases = useShruti().purchases
    if (!purchases.available) return
    try {
      const state = await purchases.getCustomerState()
      applyState(state)
    } catch (e) {
      console.error("[purchases] refresh failed:", e)
    }
  }

  async function init(): Promise<void> {
    if (ready.value) return
    const purchases = useShruti().purchases
    if (!purchases.available) {
      ready.value = true
      return
    }
    loading.value = true
    try {
      await purchases.configure()
      const [pkgs, state] = await Promise.all([
        purchases.listPackages(),
        purchases.getCustomerState(),
      ])
      packages.value = pkgs
      applyState(state)
      unsubscribe = purchases.onCustomerInfoChanged((s) => {
        applyState(s)
      })
      // Re-fetch on foreground. The RC SDK has its own push channel but
      // for sandbox / late-renewal cases the client doesn't get notified
      // until the next explicit call — without this the badge can stay
      // "active" for the whole session after a sub has expired.
      resumeHandle = await App.addListener("appStateChange", (state: AppState) => {
        if (state.isActive) void refresh()
      })

      // Bind RC's appUserID to our JWT `sub`. With `immediate: true` the
      // watcher fires once at registration: if auth has already restored
      // (race-y, auth.restore runs in parallel with this init), we logIn
      // straight away; otherwise the first non-null userId wins. Every
      // subsequent sign-in / sign-out / deleteAccount funnels through
      // useAuthStore.applySession(...), so this single watcher covers
      // all auth transitions. RC will emit SUBSCRIBER_ALIAS on the
      // anon→authed transition so the backend can reconcile any
      // purchases the user made while anonymous.
      const auth = useAuthStore()
      stopAuthWatch = watch(
        () => auth.userId,
        (newId, oldId) => {
          if (newId && newId !== oldId) {
            void purchases
              .logIn(newId)
              .then(applyState)
              .catch((e) => {
                console.warn("[purchases] logIn failed", e)
              })
          } else if (!newId && oldId) {
            void purchases
              .logOut()
              .then(applyState)
              .catch((e) => {
                console.warn("[purchases] logOut failed", e)
              })
          }
        },
        { immediate: true }
      )

      ready.value = true
    } finally {
      loading.value = false
    }
  }

  async function purchase(packageId: string): Promise<void> {
    const purchases = useShruti().purchases
    if (!purchases.available) return
    purchasing.value = true
    try {
      const state = await purchases.purchase(packageId)
      applyState(state)
    } finally {
      purchasing.value = false
    }
  }

  async function restore(): Promise<void> {
    const purchases = useShruti().purchases
    if (!purchases.available) return
    restoring.value = true
    try {
      const state = await purchases.restore()
      applyState(state)
    } finally {
      restoring.value = false
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    void resumeHandle?.remove()
    resumeHandle = undefined
    stopAuthWatch?.()
    stopAuthWatch = undefined
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
    available,
    isSubscribed,
    init,
    purchase,
    restore,
    refresh,
    dispose,
  }
})
