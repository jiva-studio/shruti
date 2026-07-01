import { defineStore } from "pinia"
import { computed, ref, watch, type WatchStopHandle } from "vue"
import { App, type AppState } from "@capacitor/app"
import { Preferences } from "@capacitor/preferences"
import { useLectorium } from "@lectorium/lectorium.js"
import type { CustomerState, PurchasePackage } from "@ports/app/purchases.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { devSubscriptionOverride, isDevBuild } from "@lectorium/services/devSubscription.js"
import { reportWarning } from "@lectorium/services/monitoring/reportError.js"

const CACHE_KEY = "purchases.lastState"

/**
 * RevenueCat CONFIGURATION_ERROR (code "23"): none of the dashboard products
 * could be fetched from the store, i.e. empty offerings. Benign for the user
 * (the app runs in free mode) and normal for App/Play reviewers, sandbox
 * accounts, and Mac Catalyst builds without provisioned StoreKit products — but
 * a store-wide product outage if it starts happening broadly. We report it at
 * warning level (not silence, not page) so the trend stays visible.
 */
function isEmptyOfferingsError(e: unknown): boolean {
  return typeof (e as { code?: unknown })?.code === "string" && (e as { code: string }).code === "23"
}

/** Sample packages for dev/preview builds where RevenueCat has no offerings
 *  (web). Uses the standard Rc package ids so the footer resolves localized
 *  plan names ("Monthly"/"Annual"); annual carries a 2-week free trial. */
function devMockPackages(): PurchasePackage[] {
  return [
    {
      packageId: "$rc_monthly",
      productId: "rc_monthly_dev",
      title: "Monthly",
      description: "",
      priceString: "$4.99",
      billingPeriod: "P1M",
    },
    {
      packageId: "$rc_annual",
      productId: "rc_annual_dev",
      title: "Annual",
      description: "",
      priceString: "$39.99",
      billingPeriod: "P1Y",
      introOffer: {
        isFree: true,
        priceString: "$0.00",
        periodUnit: "WEEK",
        periodNumberOfUnits: 2,
      },
    },
  ]
}

interface CachedState {
  activePackageId: string | undefined
  managementUrl: string | undefined
  appUserId: string | undefined
}

/**
 * Reactive view over RevenueCat. State here is derived live from the
 * SDK — `getCustomerInfo` / `purchasePackage` / `restorePurchases`
 * plus the `addCustomerInfoUpdateListener` push channel. The reinstall
 * flow relies on `restore()` rebinding the install to the Apple / Google
 * account's purchase history.
 *
 * The last confirmed entitlement is mirrored to Capacitor Preferences so
 * a returning subscriber sees Pro immediately on cold start — the async
 * SDK fetch then confirms (or, only on a successful fetch, downgrades).
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
  // True while an RC.logIn/logOut kicked off by the userId watcher is in
  // flight. `ready` flips after the first (anonymous) getCustomerState(),
  // but an account-tied subscription only surfaces once that logIn lands a
  // beat later — so any UI that gates on "is this user subscribed?" must
  // also wait for `reconciling` to clear, or it renders the non-subscribed
  // branch in the gap and flickers off when the entitlement arrives.
  const reconciling = ref(false)
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
  // Dev/preview builds (dev binary or *.pages.dev) unlock Pro by default so
  // paywalled surfaces are explorable without a real RevenueCat purchase (RC
  // isn't available on web at all). That's now configurable via the dev
  // controller — Settings → Debug → Subscription, or the e2e forceFreeTier
  // escape hatch (see services/devSubscription.ts). A real purchase
  // (`activePackageId`) always wins; the override never grants Pro on prod.
  const isSubscribed = computed(() => {
    if (activePackageId.value !== undefined) return true
    // Off-store build has no RevenueCat — Pro is bought on the website and
    // mirrored into the auth `tier` claim, so the JWT tier is the source of
    // truth for every client-side Pro gate here.
    if (__OFFSTORE_BUILD__) return useAuthStore().isPro
    const ov = devSubscriptionOverride.value
    if (ov === "free") return false
    if (ov === "pro") return isDevBuild
    return isDevBuild // default: dev/preview unlocks Pro so paywalls are explorable
  })

  function applyState(s: CustomerState): void {
    activePackageId.value = s.activePackageId
    managementUrl.value = s.managementUrl
    appUserId.value = s.appUserId
    void persistCache(s)
  }

  async function persistCache(s: CustomerState): Promise<void> {
    const cached: CachedState = {
      activePackageId: s.activePackageId,
      managementUrl: s.managementUrl,
      appUserId: s.appUserId,
    }
    try {
      await Preferences.set({ key: CACHE_KEY, value: JSON.stringify(cached) })
    } catch (e) {
      console.warn("[purchases] cache write failed", e)
    }
  }

  async function loadCache(): Promise<CachedState | null> {
    try {
      const { value } = await Preferences.get({ key: CACHE_KEY })
      if (!value) return null
      return JSON.parse(value) as CachedState
    } catch {
      return null
    }
  }

  async function clearCache(): Promise<void> {
    try {
      await Preferences.remove({ key: CACHE_KEY })
    } catch (e) {
      console.warn("[purchases] cache clear failed", e)
    }
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

  /**
   * Registers an in-flight RC.logIn/logOut from the userId watcher as the
   * current reconciliation. `reconciling` stays true until the *latest*
   * such promise settles; the identity guard means a superseding logIn
   * keeps the flag up until it too lands. `waitForLogin` reads the same
   * `loginPromise`.
   */
  function trackReconcile(p: Promise<void>): void {
    loginPromise = p
    reconciling.value = true
    void p.finally(() => {
      if (loginPromise === p) {
        loginPromise = null
        reconciling.value = false
      }
    })
  }

  async function refresh(): Promise<void> {
    const purchases = useLectorium().purchases
    if (!purchases.available) return
    // Self-heal an empty paywall: if a transient failure during init() left the
    // package list empty, re-fetch it here so it recovers without an app
    // restart (refresh runs on every appStateChange resume). A genuinely empty
    // offering set just re-fetches empty — harmless.
    if (packages.value.length === 0) {
      await purchases
        .listPackages()
        .then((p) => {
          packages.value = p
        })
        .catch((e) => {
          if (isEmptyOfferingsError(e)) reportWarning("purchases", e, { at: "refresh" })
        })
    }
    try {
      const state = await purchases.getCustomerState()
      applyState(state)
    } catch (e) {
      console.error("[purchases] refresh failed:", e)
    }
  }

  // Single-flight: app bootstrap and a paywall mount can both call init() in
  // the same frame. The `ready` guard only flips AFTER the awaits, so without
  // this both would proceed and register duplicate appStateChange /
  // onCustomerInfoChanged listeners (leaking one, storming refreshTokens on
  // resume). Coalesce concurrent callers onto one run.
  let initPromise: Promise<void> | null = null

  function init(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (initPromise) return initPromise
    initPromise = doInit().finally(() => {
      initPromise = null
    })
    return initPromise
  }

  async function doInit(): Promise<void> {
    const purchases = useLectorium().purchases
    if (!purchases.available) {
      // RevenueCat is native-only, so the web/dev preview has no real
      // offerings. Seed sample packages on dev/preview builds so the paywall
      // (incl. onboarding) renders real plan cards when the dev controller is
      // set to "free". Production web (RC unavailable) keeps an empty list.
      if (isDevBuild) packages.value = devMockPackages()
      ready.value = true
      return
    }
    loading.value = true
    try {
      // Optimistically expose the last confirmed entitlement before the
      // SDK round-trip so a returning subscriber doesn't flicker through
      // the free state for the second-or-so configure()+fetch takes. The
      // Promise.all below is now the background confirm/refresh — and it
      // downgrades only on a SUCCESSFUL getCustomerState() (see applyState
      // wiring; a thrown/failed fetch leaves the cached value in place).
      const cached = await loadCache()
      if (cached) {
        activePackageId.value = cached.activePackageId
        managementUrl.value = cached.managementUrl
        appUserId.value = cached.appUserId
      }
      await purchases.configure()
      // Tolerate a transient failure of either fetch so the listeners below
      // still register and `ready` still flips. A thrown Promise.all here used
      // to abort the entire init — leaving purchases non-functional for the
      // whole session (no onCustomerInfoChanged / appStateChange listeners) and
      // paging Sentry. A failed listPackages() just yields no plan cards; a
      // failed getCustomerState() leaves the optimistic cached entitlement in
      // place (applyState only runs on a SUCCESSFUL fetch, per the
      // "downgrade only on success" invariant above).
      const [pkgs, state] = await Promise.all([
        purchases.listPackages().catch((e) => {
          if (isEmptyOfferingsError(e)) reportWarning("purchases", e, { at: "init" })
          return [] as PurchasePackage[]
        }),
        purchases.getCustomerState().catch(() => undefined),
      ])
      packages.value = pkgs
      if (state) applyState(state)
      unsubscribe = purchases.onCustomerInfoChanged((s) => {
        applyState(s)
        // RC SDK push channel — fires when its backend learns the
        // entitlement state changed (renew, expire, RevenueCat webhook
        // landing from another device, etc.). The JWT `tier` claim is
        // frozen at issue time, so without an explicit refresh the
        // server-side flip won't reach the chat rate-limiter until the
        // next natural rotation (~15 min). Compare RC's view against
        // the cached JWT tier and force a refresh on divergence.
        const auth = useAuthStore()
        const rcActive = s.activePackageId !== undefined
        // Compare against the RAW server tier, not the (now un-coerced, but
        // still server-trusted) `isPro` — the goal is "does RC's view
        // disagree with what the server last told us?". Using the raw tier
        // keeps this stable and avoids a refresh loop if the two ever
        // diverge for a clock-skew reason.
        if (rcActive !== (auth.rawTier === "pro")) {
          void auth.refreshTokens()
        }
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
            // Account switch (a real `oldId` → different `newId`): drop the
            // optimistic cache so the previous account's Pro can't linger
            // until logIn lands. The fresh entitlement re-populates it via
            // applyState below. (The anon → first sign-in transition has no
            // `oldId` and keeps the cache so an anon purchase stays usable.)
            if (oldId) {
              void clearCache()
              activePackageId.value = undefined
            }
            // Stash the promise so `purchase()` / `restore()` can await
            // it (with a timeout) before talking to RC. We map success
            // to `applyState` and swallow errors here — `waitForLogin`
            // reads the same promise and surfaces the error path via a
            // warning + counter so we don't double-log.
            const p = purchases
              .logIn(newId)
              .then(async (s) => {
                applyState(s)
                // logIn can hit RC's "no merge" branch when `newId`
                // already had an anonymous alias (reinstall / account
                // recreate). A purchase made before signing in then
                // stays stranded on the old anon id and the user loses
                // Pro. If we land here with no active entitlement,
                // silently re-attach this device's store purchase to
                // `newId`: RC aliases the anon owner into it and fires a
                // TRANSFER webhook, so the server reconciles too. Gated
                // on "no entitlement" so we don't sync users who already
                // have Pro (RC warns against indiscriminate syncs).
                if (!s.activePackageId) {
                  try {
                    const recovered = await purchases.recoverPurchases()
                    applyState(recovered)
                    if (recovered.activePackageId) await auth.refreshTokens()
                  } catch (e) {
                    console.warn("[purchases] recoverPurchases failed", e)
                  }
                }
              })
              .catch((e) => {
                console.warn("[purchases] logIn failed", e)
                throw e
              })
            trackReconcile(p)
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
            trackReconcile(p)
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
    // Drop the cached entitlement up front so a flaky SDK logOut can't
    // leave the prior account's Pro persisted for the next cold start.
    await clearCache()
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
    reconciling.value = false
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
