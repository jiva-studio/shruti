import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"

/**
 * The identity reconcile used to run unbounded, and the auth watcher is
 * `{ immediate: true }` — so every cold start with a restored session entered
 * a window in which the paywall hid its plan cards, the Settings subscription
 * row vanished and a Pro-gated tap was dropped, for as long as RevenueCat
 * took. Forever, if it never answered (#1838).
 *
 * The budget caps how long a surface renders "in progress". It must NOT cap
 * `loginPromise`: `purchase()` / `restore()` still await the real round-trip,
 * because a receipt filed under the anonymous app_user_id is a far worse
 * outcome. And the state it expires INTO is "unknown", not "not subscribed" —
 * otherwise #1797 walks straight back in.
 */

const PRO: CustomerState = {
  activePackageId: "$rc_annual",
  activeEntitlements: ["pro"],
  managementUrl: "https://apps.apple.com/account/subscriptions",
  appUserId: "rc-user",
}

const FREE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: "$RCAnonymousID:abc",
}

const auth = reactive({
  userId: null as string | null,
  anonymous: true,
  rawTier: "free",
  isPro: false,
  refreshTokens: vi.fn().mockResolvedValue(undefined),
  invalidateAndSyncTier: vi.fn(),
})

const prefs = new Map<string, string>()
const purchasesLogIn = vi.fn<(id: string) => Promise<CustomerState>>()
const purchasesPurchase = vi.fn<(id: string) => Promise<CustomerState>>()

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value)
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key)
    },
  },
}))

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}))

vi.mock("@lectorium/stores/useAuthStore.js", () => ({
  useAuthStore: () => auth,
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    purchases: {
      available: true,
      configure: async () => undefined,
      listPackages: async () => [],
      getCustomerState: async () => FREE,
      purchase: purchasesPurchase,
      restore: vi.fn(),
      logIn: purchasesLogIn,
      logOut: vi.fn().mockResolvedValue(FREE),
      recoverPurchases: vi.fn().mockResolvedValue(FREE),
      onCustomerInfoChanged: () => () => undefined,
    },
  }),
}))

import { usePurchasesStore } from "../usePurchasesStore.js"

const started: ReturnType<typeof usePurchasesStore>[] = []

/** Cold start, then a restored session lands — the watcher fires a logIn
 *  that we control the settling of. */
async function bootIntoReconcile(): Promise<{
  store: ReturnType<typeof usePurchasesStore>
  settle: (s: CustomerState) => void
}> {
  let settle: (s: CustomerState) => void = () => undefined
  purchasesLogIn.mockReturnValue(
    new Promise<CustomerState>((resolve) => {
      settle = resolve
    })
  )
  const store = usePurchasesStore()
  started.push(store)
  await store.init()
  auth.userId = "u-1"
  auth.anonymous = false
  await nextTick()
  return { store, settle }
}

describe("usePurchasesStore — the reconcile has a budget", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    purchasesLogIn.mockReset()
    purchasesPurchase.mockReset().mockResolvedValue(PRO)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    while (started.length > 0) started.pop()!.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("stops reporting progress once the budget expires", async () => {
    const { store } = await bootIntoReconcile()
    expect(store.reconciling).toBe(true)

    await vi.advanceTimersByTimeAsync(5000)

    expect(store.reconciling).toBe(false)
  })

  it("expires into 'unknown', never into 'not subscribed'", async () => {
    const { store } = await bootIntoReconcile()

    await vi.advanceTimersByTimeAsync(5000)

    // `resolved` is what every Pro gate reads. It must stay false: the store
    // still does not know, and a surface that treated the expiry as a "no"
    // would lock a payer out of what they bought.
    expect(store.reconcileOverdue).toBe(true)
    expect(store.resolved).toBe(false)
  })

  it("expires into a state the purchase block can still be operated from", async () => {
    const { store } = await bootIntoReconcile()
    // Inside the budget an answer is still coming, so the block waits.
    expect(store.settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)

    // Nothing better is coming. The plans are the offering, not the
    // entitlement — refusing the sale here is what left the paywall dead for
    // the user `ensurePro` had just routed to it (#1892).
    expect(store.settled).toBe(true)
    expect(store.resolved).toBe(false)
  })

  it("completes a purchase from the overdue state, logIn or no logIn", async () => {
    const { store } = await bootIntoReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    const pending = store.purchase("$rc_annual")
    // `purchase()` still gives the real round-trip its own budget before
    // filing the receipt (see the test above) — but it does not wait forever.
    await vi.advanceTimersByTimeAsync(5000)
    await pending

    expect(purchasesPurchase).toHaveBeenCalledWith("$rc_annual")
    expect(store.isSubscribed).toBe(true)
  })

  it("keeps the flags up while the answer is still inside the budget", async () => {
    const { store } = await bootIntoReconcile()

    await vi.advanceTimersByTimeAsync(4999)

    expect(store.reconciling).toBe(true)
    expect(store.resolved).toBe(false)
  })

  it("resolves as soon as the round-trip lands, late or not", async () => {
    const { store, settle } = await bootIntoReconcile()
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.resolved).toBe(false)

    settle(PRO)
    await vi.advanceTimersByTimeAsync(0)

    expect(store.reconciling).toBe(false)
    expect(store.reconcileOverdue).toBe(false)
    expect(store.resolved).toBe(true)
    expect(store.isSubscribed).toBe(true)
  })

  it("does not release purchase() early — the receipt still waits for logIn", async () => {
    const { store, settle } = await bootIntoReconcile()
    await vi.advanceTimersByTimeAsync(5000)
    // UI is free to move on; the SDK call is not.
    expect(store.reconciling).toBe(false)

    const pending = store.purchase("$rc_annual")
    await vi.advanceTimersByTimeAsync(0)
    expect(purchasesPurchase).not.toHaveBeenCalled()

    settle(FREE)
    await pending

    expect(purchasesPurchase).toHaveBeenCalledWith("$rc_annual")
  })
})
