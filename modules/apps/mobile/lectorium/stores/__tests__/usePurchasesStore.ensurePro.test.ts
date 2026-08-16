import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { CustomerState } from "@ports/app/purchases.js"

/**
 * `isSubscribed` is `activePackageId !== undefined`, so it reads FALSE for a
 * paying subscriber for the length of the identity reconcile — a fresh
 * install, a reinstall or an account switch has no cache to seed it from.
 * Eight paywall entry points read it bare (#1839).
 *
 * `ensurePro` is the one gate they now share. It must WAIT rather than answer
 * from the gap, and it must open the paywall itself when the answer really is
 * no — a caller that merely refuses to act (the SettingsView pattern) turns a
 * window entered on every launch into a dead button.
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
const requestOpen = vi.fn()
/** What the first (anonymous) customer fetch reports. */
const customerState = { value: FREE }
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

vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => auth }))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen }),
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    purchases: {
      available: true,
      configure: async () => undefined,
      listPackages: async () => [],
      getCustomerState: async () => customerState.value,
      purchase: vi.fn(),
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

/** Cold start, then a restored session lands — the watcher fires a logIn we
 *  control the settling of, i.e. the store is mid-reconcile on return. */
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

describe("usePurchasesStore.ensurePro", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    prefs.clear()
    auth.userId = null
    auth.anonymous = true
    requestOpen.mockReset()
    customerState.value = FREE
    purchasesLogIn.mockReset()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    while (started.length > 0) started.pop()!.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("waits out the reconcile instead of answering from the gap", async () => {
    const { store, settle } = await bootIntoReconcile()
    // What every one of the eight sites used to read at this instant.
    expect(store.isSubscribed).toBe(false)

    const gate = store.ensurePro("smartLibrary")
    await vi.advanceTimersByTimeAsync(10)
    // Neither answered nor bounced yet.
    expect(requestOpen).not.toHaveBeenCalled()

    settle(PRO)

    await expect(gate).resolves.toBe(true)
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it("opens the paywall, with the feature, once the answer really is no", async () => {
    const { store, settle } = await bootIntoReconcile()
    const gate = store.ensurePro("notesStudio")
    settle(FREE)

    await expect(gate).resolves.toBe(false)
    expect(requestOpen).toHaveBeenCalledWith("notesStudio")
  })

  it("answers a known subscriber without waiting for anything", async () => {
    // Entitlement already in hand when the reconcile starts (the common
    // cold start: cache seeded, first fetch confirms).
    customerState.value = PRO
    const { store } = await bootIntoReconcile()

    await expect(store.ensurePro("shareTranscript")).resolves.toBe(true)
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it("gives up after the budget rather than leaving the tap hanging", async () => {
    const { store } = await bootIntoReconcile()

    const gate = store.ensurePro()
    await vi.advanceTimersByTimeAsync(5000)

    // The logIn never settled. A dead button would be the worse outcome; the
    // paywall self-corrects into Manage if RevenueCat later says "subscribed".
    await expect(gate).resolves.toBe(false)
    expect(requestOpen).toHaveBeenCalledOnce()
  })

  it("routes to a paywall that can sell, not one it just disabled", async () => {
    const { store } = await bootIntoReconcile()

    const gate = store.ensurePro("smartLibrary")
    await vi.advanceTimersByTimeAsync(5000)
    await expect(gate).resolves.toBe(false)

    // The wait that sent the user here is the same one that latched
    // `reconcileOverdue`. What the purchase block binds to must survive it —
    // otherwise the only branch that reaches the paywall is the one that
    // makes it unbuyable (#1892).
    expect(requestOpen).toHaveBeenCalledWith("smartLibrary")
    expect(store.settled).toBe(true)
    expect(store.resolved).toBe(false)
  })

  it("does not re-spend the budget on the next tap while logIn hangs", async () => {
    const { store } = await bootIntoReconcile()
    const first = store.ensurePro()
    await vi.advanceTimersByTimeAsync(5000)
    await first
    requestOpen.mockReset()

    // Same never-settling promise: waiting on it again buys five more seconds
    // of nothing, so the second tap goes straight through.
    const second = store.ensurePro("notesStudio")
    await vi.advanceTimersByTimeAsync(0)

    await expect(second).resolves.toBe(false)
    expect(requestOpen).toHaveBeenCalledWith("notesStudio")
  })

  it("never routes a subscriber to the sell view, budget or no budget", async () => {
    // Entitlement already in hand when the identity round-trip hangs past its
    // budget, i.e. "subscribed, identity unknown".
    customerState.value = PRO
    const { store } = await bootIntoReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(store.reconcileOverdue).toBe(true)
    await expect(store.ensurePro("smartLibrary")).resolves.toBe(true)
    expect(requestOpen).not.toHaveBeenCalled()
  })
})
