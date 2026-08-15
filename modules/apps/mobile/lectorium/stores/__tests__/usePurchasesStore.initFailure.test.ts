import { beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"

/**
 * `init()` runs once per session (postMount, behind a module flag), so
 * anything that can throw between the customer fetch and the flags it sets
 * strands the paywall for the whole run, with no retry (#1796). The
 * `appStateChange` registration was the last such hole.
 *
 * What the paywall actually waits on is `resolved`, not `ready` — `ready`
 * only says the first round-trip is over, while `resolved` says the
 * subscribed answer is final (#1797, #1838). A failed init has to land BOTH,
 * or the loading string is permanent all the same: there is no identity
 * reconcile pending, so "we don't know" would be a lie.
 */

const FREE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: "rc-user",
}

const auth = reactive({
  userId: null as string | null,
  anonymous: true,
  rawTier: "free",
  isPro: false,
  refreshTokens: vi.fn().mockResolvedValue(undefined),
})

const prefs = new Map<string, string>()
const addListener = vi.fn<() => Promise<{ remove: () => void }>>()
/** Swapped per case to make the step BEFORE the listener throw. */
const onCustomerInfoChanged = vi.fn<() => () => void>()

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

vi.mock("@capacitor/app", () => ({ App: { addListener: () => addListener() } }))

vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => auth }))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    purchases: {
      available: true,
      configure: async () => undefined,
      listPackages: async () => [
        { packageId: "$rc_annual", priceString: "$19.99", billingPeriod: "P1Y" },
      ],
      getCustomerState: async () => FREE,
      purchase: vi.fn(),
      restore: vi.fn(),
      logIn: vi.fn(),
      logOut: vi.fn(),
      recoverPurchases: vi.fn(),
      onCustomerInfoChanged: () => onCustomerInfoChanged(),
    },
  }),
}))

import { usePurchasesStore } from "../usePurchasesStore.js"

describe("usePurchasesStore — init survives a failed listener registration", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
    onCustomerInfoChanged.mockReset().mockReturnValue(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  it("still becomes ready when the appStateChange registration rejects", async () => {
    addListener.mockRejectedValue(new Error("plugin unavailable"))
    const store = usePurchasesStore()

    await expect(store.init()).resolves.toBeUndefined()

    // Both gates. Without them the loading string is permanent.
    expect(store.ready).toBe(true)
    expect(store.resolved).toBe(true)
    expect(store.loading).toBe(false)
    // Everything the registration was ordered after still landed.
    expect(store.packages).toHaveLength(1)
    store.dispose()
  })

  it("becomes ready even when init throws outright", async () => {
    // Any unexpected throw in the body, not just the listener: `ready` lives
    // in the `finally` so the paywall falls through to the "unavailable here"
    // note instead of never resolving.
    onCustomerInfoChanged.mockImplementation(() => {
      throw new Error("boom")
    })
    const store = usePurchasesStore()

    await expect(store.init()).rejects.toThrow("boom")

    expect(store.ready).toBe(true)
    expect(store.resolved).toBe(true)
    store.dispose()
  })

  it("registers the listener once on the happy path", async () => {
    const store = usePurchasesStore()
    await store.init()

    expect(addListener).toHaveBeenCalledOnce()
    expect(store.ready).toBe(true)
    expect(store.resolved).toBe(true)
    store.dispose()
  })
})
