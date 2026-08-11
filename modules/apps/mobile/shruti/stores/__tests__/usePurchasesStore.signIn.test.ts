import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"

/**
 * The identity transitions the RC binding watcher has to tell apart.
 *
 * An anonymous session carries a REAL `auth.users` id, so `userId` changes on
 * every sign-in — including the one where the anonymous id is merely
 * cross-linked to the account the same person already had. Treating that as an
 * account switch drops the optimistic entitlement cache and renders a
 * subscriber as free until `Purchases.logIn` lands — for the rest of the
 * session if it rejects, since the watcher does not fire again (#1628).
 */

const PRO: CustomerState = {
  activePackageId: "$rc_annual",
  activeEntitlements: ["pro"],
  managementUrl: "https://apps.apple.com/account/subscriptions",
  appUserId: "$RCAnonymousID:abc",
}

const FREE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: "rc-user",
}

/** The live auth session the store watches. */
const auth = reactive({
  userId: null as string | null,
  anonymous: true,
  rawTier: "free",
  isPro: false,
  refreshTokens: vi.fn().mockResolvedValue(undefined),
})

const prefs = new Map<string, string>()
const purchasesLogIn = vi.fn<(id: string) => Promise<CustomerState>>()
const purchasesLogOut = vi.fn<() => Promise<CustomerState>>()
const recoverPurchases = vi.fn<() => Promise<CustomerState>>()
const getCustomerState = vi.fn<() => Promise<CustomerState>>()

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

vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => auth,
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    purchases: {
      available: true,
      configure: async () => undefined,
      listPackages: async () => [],
      getCustomerState,
      purchase: vi.fn(),
      restore: vi.fn(),
      logIn: purchasesLogIn,
      logOut: purchasesLogOut,
      recoverPurchases,
      onCustomerInfoChanged: () => () => undefined,
    },
  }),
}))

import { usePurchasesStore } from "../usePurchasesStore.js"

/** Live stores, torn down between cases: the watcher is registered on a
 *  module-level `auth` that outlives the pinia instance, so a store left
 *  running would keep reacting to the next test's transitions. */
const started: ReturnType<typeof usePurchasesStore>[] = []

/** Cold start of a device that already knows it holds Pro. */
async function initWithCachedPro(): Promise<ReturnType<typeof usePurchasesStore>> {
  prefs.set(
    "purchases.lastState",
    JSON.stringify({
      activePackageId: PRO.activePackageId,
      managementUrl: PRO.managementUrl,
      appUserId: PRO.appUserId,
    })
  )
  const store = usePurchasesStore()
  started.push(store)
  await store.init()
  return store
}

/** Apply a session the way `useAuthStore.applySession` does — both fields at
 *  once — and let the watcher run. */
async function applySession(userId: string | null, anonymous: boolean): Promise<void> {
  auth.userId = userId
  auth.anonymous = anonymous
  await nextTick()
}

describe("usePurchasesStore — RC binding across identity transitions", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    purchasesLogIn.mockReset().mockResolvedValue(PRO)
    purchasesLogOut.mockReset().mockResolvedValue(FREE)
    recoverPurchases.mockReset().mockResolvedValue(FREE)
    // The SDK has nothing to say yet — the cache is all the store has, which is
    // exactly the window this is about.
    getCustomerState.mockReset().mockRejectedValue(new Error("offline"))
  })

  afterEach(() => {
    for (const s of started.splice(0)) s.dispose()
    vi.restoreAllMocks()
  })

  it("keeps the anonymous purchase when that id is cross-linked to an account", async () => {
    // Bought Pro at the onboarding paywall while anonymous …
    await applySession("anon-1", true)
    const store = await initWithCachedPro()
    expect(store.activePackageId).toBe("$rc_annual")

    // … then signed in, and the server linked the anonymous id to the account
    // the user already had, so `userId` changes.
    purchasesLogIn.mockImplementation(() => new Promise(() => undefined)) // never settles
    await applySession("acct-9", false)

    expect(purchasesLogIn).toHaveBeenCalledWith("acct-9")
    // Still Pro while logIn is in flight, and the cold-start cache survives for
    // the next launch.
    expect(store.activePackageId).toBe("$rc_annual")
    expect(prefs.has("purchases.lastState")).toBe(true)
  })

  it("still renders Pro when logIn rejects on the cross-link", async () => {
    // The failure the cache exists for: no retry, and the watcher will not fire
    // again, so a dropped cache would mean free for the whole session.
    await applySession("anon-1", true)
    const store = await initWithCachedPro()

    purchasesLogIn.mockRejectedValue(new Error("network"))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await applySession("acct-9", false)
    await nextTick()

    expect(store.activePackageId).toBe("$rc_annual")
    expect(prefs.has("purchases.lastState")).toBe(true)
  })

  it("drops the cache when one account is replaced by another", async () => {
    // A genuine switch: signed in as one account, then signed in as a second.
    // The first account's Pro must not linger on the second.
    await applySession("acct-1", false)
    const store = await initWithCachedPro()
    expect(store.activePackageId).toBe("$rc_annual")

    purchasesLogIn.mockImplementation(() => new Promise(() => undefined))
    await applySession("acct-2", false)

    expect(store.activePackageId).toBeUndefined()
    expect(prefs.has("purchases.lastState")).toBe(false)
  })

  it("drops the cache when one anonymous identity replaces another", async () => {
    // Account deleted → the device bootstraps a fresh anonymous id. Different
    // identity, so the previous one's entitlement goes with it.
    await applySession("anon-1", true)
    const store = await initWithCachedPro()

    purchasesLogIn.mockImplementation(() => new Promise(() => undefined))
    await applySession("anon-2", true)

    expect(store.activePackageId).toBeUndefined()
    expect(prefs.has("purchases.lastState")).toBe(false)
  })

  it("logs out of RC on sign-out", async () => {
    await applySession("acct-1", false)
    await initWithCachedPro()

    await applySession(null, true)
    await nextTick()

    expect(purchasesLogOut).toHaveBeenCalledOnce()
  })
})
