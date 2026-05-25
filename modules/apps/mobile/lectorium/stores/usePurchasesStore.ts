import { defineStore } from "pinia"
import { computed, ref, watch, type WatchStopHandle } from "vue"
import { App, type AppState } from "@capacitor/app"
import { useLectorium } from "@lectorium/lectorium.js"
import type { CustomerState, PurchasePackage } from "@ports/app/purchases.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"

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
  /**
   * Tracks the in-flight `Purchases.logIn` / `logOut` triggered by the
   * userId watcher. `purchase()` and `restore()` await this (with a
   * timeout) before talking to the RC SDK so we don't fire a purchase
   * under the anonymous app_user_id when the user just signed in in
   * the same frame. Reset to null on completion (success or failure).
   *
   * Graceful failure: if logIn rejects or the await times out we still
   * proceed with the purchase. RC's SUBSCRIBER_ALIAS event lets the
   * backend reconcile the anonymous purchase with the authed identity
   * once logIn finally succeeds.
   */
  let loginPromise: Promise<void> | null = null

  const available = computed(() => useLectorium().purchases.available)
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

  /**
   * Resolves when the in-flight RC.logIn/logOut from the userId watcher
   * settles, or after `timeoutMs`. Never rejects — on a timeout or a
   * logIn failure we log + count and let the caller proceed. This is
   * the "graceful failure" leg of the RC.logIn race fix: blocking a
   * purchase forever on a network flake would be far worse UX than
   * letting RC fire the purchase under the anonymous app_user_id and
   * trusting SUBSCRIBER_ALIAS to reconcile it server-side.
   */
  async function waitForLogin(timeoutMs: number): Promise<void> {
    const p = loginPromise
    if (!p) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    try {
      const result = await Promise.race([
        p.then(() => "ok" as const).catch(() => "error" as const),
        timeout,
      ])
      if (result !== "ok") {
        // Failed-or-timed-out — proceed anyway. SUBSCRIBER_ALIAS handles
        // late binding when (and if) logIn finally succeeds.
        console.warn("[purchases] RC.logIn did not settle before purchase/restore", {
          reason: result,
          timeoutMs,
        })
        // Metric (observability port doesn't exist yet — console-only).
        console.warn("[metric] rc_login_pre_purchase_failed_total +=1", {
          reason: result,
        })
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function refresh(): Promise<void> {
    const purchases = useLectorium().purchases
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
    const purchases = useLectorium().purchases
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
            // Stash the promise so `purchase()` / `restore()` can await
            // it (with a timeout) before talking to RC. We map success
            // to `applyState` and swallow errors here — `waitForLogin`
            // reads the same promise and surfaces the error path via a
            // warning + counter so we don't double-log.
            const p = purchases
              .logIn(newId)
              .then((s) => {
                applyState(s)
              })
              .catch((e) => {
                console.warn("[purchases] logIn failed", e)
                throw e
              })
            loginPromise = p
            void p.finally(() => {
              if (loginPromise === p) loginPromise = null
            })
          } else if (!newId && oldId) {
            const p = purchases
              .logOut()
              .then((s) => {
                applyState(s)
              })
              .catch((e) => {
                console.warn("[purchases] logOut failed", e)
                throw e
              })
            loginPromise = p
            void p.finally(() => {
              if (loginPromise === p) loginPromise = null
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
    const purchases = useLectorium().purchases
    if (!purchases.available) return
    purchasing.value = true
    try {
      // Make sure any in-flight RC.logIn from a just-now signin has
      // landed before we kick off the purchase, otherwise the receipt
      // lands under the anonymous app_user_id and the user has to wait
      // for SUBSCRIBER_ALIAS reconciliation to see Pro.
      await waitForLogin(5000)
      const state = await purchases.purchase(packageId)
      applyState(state)
      // RC sends the INITIAL_PURCHASE webhook almost immediately; by the
      // time we get back here the server-side tier has likely flipped to
      // 'pro'. Force a token refresh now so the new claim lands in the
      // access JWT — otherwise the chat rate-limiter sees the old tier
      // for up to 15 min.
      await useAuthStore().refreshTokens()
    } finally {
      purchasing.value = false
    }
  }

  async function restore(): Promise<void> {
    const purchases = useLectorium().purchases
    if (!purchases.available) return
    restoring.value = true
    try {
      // Same race as `purchase()`: restore under the wrong app_user_id
      // would attach the user's existing receipts to the anon RC alias.
      await waitForLogin(5000)
      const state = await purchases.restore()
      applyState(state)
      await useAuthStore().refreshTokens()
    } finally {
      restoring.value = false
    }
  }

  /**
   * Explicit RC SDK sign-out. Called from useAuthStore.deleteAccount
   * BEFORE the session flips, so the userId watcher's anonymous logIn
   * doesn't race the in-flight SDK logOut. Swallows SDK errors — the
   * server account is already gone, so a flaky RC call here must not
   * block the caller.
   */
  async function logOut(): Promise<void> {
    if (!available.value) return
    try {
      const state = await useLectorium().purchases.logOut()
      applyState(state)
    } catch (e) {
      console.warn("[purchases] logOut failed", e)
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
    logOut,
    dispose,
  }
})
