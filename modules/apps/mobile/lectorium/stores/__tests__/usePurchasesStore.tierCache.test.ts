import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"
import type { AuthSession } from "@ports/app/auth.js"

/**
 * A purchase and a sign-in wait on the same thing: the RevenueCat webhook
 * writing the new tier server-side. Sign-in drops the 5-minute `/auth/me`
 * cache and probes until it lands; `purchase()` / `restore()` used to just
 * refresh the token, which left a cache stamped moments earlier (by the
 * post-signin sync) in force — so the chat composer's own `ensureFresh()`
 * short-circuited straight through the window the webhook lands in and the
 * send went out as `tier=free`, seconds after payment (#1734).
 */

const PRO: CustomerState = {
  activePackageId: "$rc_annual",
  activeEntitlements: ["pro"],
  managementUrl: undefined,
  appUserId: "rc-user",
}

const FREE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: "rc-user",
}

const prefs = new Map<string, string>()
const fetchMe = vi.fn<() => Promise<{ tier: string; tierExpiresAt: number | null } | null>>()
const portRefreshTokens = vi.fn<() => Promise<AuthSession | null>>()
const rcPurchase = vi.fn<(id: string) => Promise<CustomerState>>()
const rcRestore = vi.fn<() => Promise<CustomerState>>()

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

vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => ({ resetComposeLock: vi.fn() }),
}))

vi.mock("@lectorium/services/monitoring/index.js", () => ({
  setMonitoringUser: vi.fn(),
  setMonitoringTag: vi.fn(),
}))

vi.mock("@lectorium/services/dataWipe.js", () => ({ wipeLocalUserData: vi.fn() }))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    auth: {
      initialize: async () => null,
      onSessionChange: () => () => undefined,
      getSession: () => null,
      fetchMe: () => fetchMe(),
      refreshTokens: () => portRefreshTokens(),
    },
    purchases: {
      available: true,
      configure: async () => undefined,
      listPackages: async () => [],
      getCustomerState: async () => FREE,
      purchase: (id: string) => rcPurchase(id),
      restore: () => rcRestore(),
      logIn: vi.fn(),
      logOut: vi.fn(),
      recoverPurchases: vi.fn(),
      onCustomerInfoChanged: () => () => undefined,
    },
  }),
}))

import { useAuthStore } from "../useAuthStore.js"
import { usePurchasesStore } from "../usePurchasesStore.js"

const started: ReturnType<typeof usePurchasesStore>[] = []

async function startedStore(): Promise<ReturnType<typeof usePurchasesStore>> {
  const store = usePurchasesStore()
  started.push(store)
  await store.init()
  return store
}

/** The state a user is in moments after signing in: `/auth/me` answered, so
 *  the 5-minute cache is stamped and `ensureFresh()` is a no-op. */
async function stampTierCache(): Promise<void> {
  fetchMe.mockResolvedValueOnce({ tier: "free", tierExpiresAt: null })
  await useAuthStore().ensureFresh()
  expect(fetchMe).toHaveBeenCalledTimes(1)
  await useAuthStore().ensureFresh()
  expect(fetchMe, "the cache really is warm").toHaveBeenCalledTimes(1)
}

describe("usePurchasesStore — a purchase must invalidate the tier cache", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    prefs.clear()
    fetchMe.mockReset()
    portRefreshTokens.mockReset().mockResolvedValue(null)
    rcPurchase.mockReset().mockResolvedValue(PRO)
    rcRestore.mockReset().mockResolvedValue(PRO)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const s of started.splice(0)) s.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("purchase() leaves the next ensureFresh() free to probe again", async () => {
    const auth = useAuthStore()
    const store = await startedStore()
    await stampTierCache()

    // The probe the purchase kicks off is still in flight — the webhook has
    // not landed, so nothing has re-stamped the cache.
    fetchMe.mockReturnValueOnce(new Promise(() => undefined))
    await store.purchase("$rc_annual")
    expect(fetchMe, "the purchase must go and ask the server").toHaveBeenCalledTimes(2)

    // The chat send, seconds after payment.
    fetchMe.mockResolvedValueOnce({ tier: "pro", tierExpiresAt: null })
    await auth.ensureFresh()

    expect(fetchMe).toHaveBeenCalledTimes(3)
  })

  it("restore() does the same", async () => {
    const auth = useAuthStore()
    const store = await startedStore()
    await stampTierCache()

    fetchMe.mockReturnValueOnce(new Promise(() => undefined))
    await store.restore()
    expect(fetchMe).toHaveBeenCalledTimes(2)

    fetchMe.mockResolvedValueOnce({ tier: "pro", tierExpiresAt: null })
    await auth.ensureFresh()

    expect(fetchMe).toHaveBeenCalledTimes(3)
  })

  it("keeps probing until the webhook lands, then refreshes the JWT", async () => {
    vi.useFakeTimers()
    const store = await startedStore()

    // Attempt 1 is too early — this is the answer that used to freeze the
    // cache for five minutes. Attempt 2 sees the flip.
    fetchMe.mockResolvedValueOnce({ tier: "free", tierExpiresAt: null })
    fetchMe.mockResolvedValueOnce({ tier: "pro", tierExpiresAt: null })

    await store.purchase("$rc_annual")
    await vi.advanceTimersByTimeAsync(3500)

    expect(fetchMe).toHaveBeenCalledTimes(2)
    expect(portRefreshTokens, "the new claim has to reach the access JWT").toHaveBeenCalled()
  })
})
