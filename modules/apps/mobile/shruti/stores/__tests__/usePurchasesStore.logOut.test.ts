import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"

/**
 * Handing the device to the next person has to take the entitlement with it
 * (#1829). Two things used to leak it: `logOut()` cleared only the persisted
 * copy — leaving `activePackageId` live for the whole RC round-trip, and
 * forever if that round-trip failed — and the identity watcher, the session's
 * other route to a clean state, was registered after `configure()`, so a
 * throw there cost the session its watcher entirely.
 */

const PRO: CustomerState = {
  activePackageId: "$rc_annual",
  activeEntitlements: ["pro"],
  managementUrl: "https://apps.apple.com/account/subscriptions",
  appUserId: "rc-user",
}

const ANON: CustomerState = {
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
})

const prefs = new Map<string, string>()
/** Flipped by the "no RevenueCat on this build" case. */
const rcAvailable = { value: true }
const configure = vi.fn<() => Promise<void>>()
const purchasesLogOut = vi.fn<() => Promise<CustomerState>>()
const purchasesLogIn = vi.fn<(id: string) => Promise<CustomerState>>()

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

vi.mock("@shruti/stores/useAuthStore.js", () => ({ useAuthStore: () => auth }))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    purchases: {
      get available(): boolean {
        return rcAvailable.value
      },
      configure,
      listPackages: async () => [],
      getCustomerState: async () => PRO,
      purchase: vi.fn(),
      restore: vi.fn(),
      logIn: purchasesLogIn,
      logOut: purchasesLogOut,
      recoverPurchases: vi.fn(),
      onCustomerInfoChanged: () => () => undefined,
    },
  }),
}))

import { usePurchasesStore } from "../usePurchasesStore.js"

const started: ReturnType<typeof usePurchasesStore>[] = []

/** Cold start of a device that already knows it holds Pro. */
async function bootWithCachedPro(): Promise<ReturnType<typeof usePurchasesStore>> {
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

describe("usePurchasesStore.logOut — the entitlement leaves with the account", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    rcAvailable.value = true
    configure.mockReset().mockResolvedValue(undefined)
    purchasesLogIn.mockReset().mockResolvedValue(PRO)
    purchasesLogOut.mockReset().mockResolvedValue(ANON)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    while (started.length > 0) started.pop()!.dispose()
    vi.restoreAllMocks()
  })

  it("drops the entitlement before the SDK round-trip, not after it", async () => {
    const store = await bootWithCachedPro()
    expect(store.isSubscribed).toBe(true)

    let release: (s: CustomerState) => void = () => undefined
    purchasesLogOut.mockReturnValue(
      new Promise<CustomerState>((resolve) => {
        release = resolve
      })
    )
    const pending = store.logOut()
    await nextTick()

    // The whole point: Pro surfaces are locked for the duration of the RC
    // call, not unlocked until it lands.
    expect(store.isSubscribed).toBe(false)
    release(ANON)
    await pending
  })

  it("keeps the entitlement dropped when the SDK logOut rejects", async () => {
    const store = await bootWithCachedPro()
    purchasesLogOut.mockRejectedValue(new Error("offline"))

    await store.logOut()

    expect(store.isSubscribed).toBe(false)
    // And nothing is left for `loadCache()` to hand the next cold start.
    expect(prefs.get("purchases.lastState")).toBeUndefined()
  })

  it("clears the entitlement even when the build has no RevenueCat", async () => {
    const store = await bootWithCachedPro()
    // The availability guard used to sit ABOVE the clear, so a build that
    // lost RC mid-session (or never had it) kept the cached Pro forever.
    rcAvailable.value = false

    await store.logOut()

    expect(purchasesLogOut).not.toHaveBeenCalled()
    expect(store.activePackageId).toBeUndefined()
    expect(prefs.get("purchases.lastState")).toBeUndefined()
  })
})

describe("usePurchasesStore — the identity watcher survives a failed configure()", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    rcAvailable.value = true
    configure.mockReset().mockResolvedValue(undefined)
    purchasesLogIn.mockReset().mockResolvedValue(PRO)
    purchasesLogOut.mockReset().mockResolvedValue(ANON)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    while (started.length > 0) started.pop()!.dispose()
    vi.restoreAllMocks()
  })

  it("still unbinds RC on sign-out after configure() threw", async () => {
    configure.mockRejectedValue(new Error("no api key"))
    const store = usePurchasesStore()
    started.push(store)
    await expect(store.init()).rejects.toThrow("no api key")

    // Sign in, then out. Without a registered watcher neither transition
    // reached the SDK at all, so nothing ever cleared the cached state.
    auth.userId = "u-1"
    auth.anonymous = false
    await nextTick()
    auth.userId = null
    auth.anonymous = true
    await nextTick()

    expect(purchasesLogOut).toHaveBeenCalled()
  })
})
