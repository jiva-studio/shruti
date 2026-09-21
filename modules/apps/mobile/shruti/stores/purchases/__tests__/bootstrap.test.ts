import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { CustomerState, IPurchases, PurchasePackage } from "@ports/app/purchases.js"
import type { EntitlementState } from "@shruti/stores/purchases/entitlementState.js"

interface AppStateListener {
  (state: { isActive: boolean }): void
}

const listeners: AppStateListener[] = []
const removed: number[] = []
let addListenerFails: Error | null = null

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_event: string, listener: AppStateListener) => {
      if (addListenerFails) throw addListenerFails
      listeners.push(listener)
      return {
        async remove() {
          removed.push(listeners.indexOf(listener))
        },
      }
    },
  },
}))

const warnings: { scope: string; context?: Record<string, unknown> }[] = []
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportWarning: (scope: string, _e: unknown, context?: Record<string, unknown>) => {
    warnings.push({ scope, context })
  },
}))

import { createPurchasesBootstrap, type PurchasesBootstrapDeps } from "../bootstrap.js"

const PRO: CustomerState = {
  activePackageId: "$rc_annual",
  activeEntitlements: ["pro"],
  managementUrl: "https://manage",
  appUserId: "rc-user",
}

function pkg(packageId: string): PurchasePackage {
  return {
    packageId,
    productId: `${packageId}_prod`,
    title: packageId,
    description: "",
    priceString: "$1.00",
    billingPeriod: "P1M",
  }
}

class RcError extends Error {
  constructor(readonly code: string) {
    super(`rc ${code}`)
  }
}

interface Harness {
  readonly deps: PurchasesBootstrapDeps
  readonly applied: CustomerState[]
  readonly hydrated: number[]
  readonly authWatches: number[]
  readonly calls: string[]
  readonly unsubscribed: number[]
}

function harness(
  purchases: Partial<IPurchases> & { available: boolean },
  options: { authWatchFails?: Error } = {}
): Harness {
  const applied: CustomerState[] = []
  const hydrated: number[] = []
  const authWatches: number[] = []
  const calls: string[] = []
  const unsubscribed: number[] = []

  const entitlement: EntitlementState = {
    activePackageId: ref<string | undefined>(undefined),
    managementUrl: ref<string | undefined>(undefined),
    appUserId: ref<string | undefined>(undefined),
    apply: (s) => {
      applied.push(s)
    },
    hydrate: async () => {
      hydrated.push(calls.length)
    },
    forget: async () => undefined,
  }

  const port: IPurchases = {
    configure: async () => {
      calls.push("configure")
    },
    listPackages: async () => {
      calls.push("listPackages")
      return []
    },
    getCustomerState: async () => {
      calls.push("getCustomerState")
      return PRO
    },
    purchase: async () => PRO,
    restore: async () => PRO,
    logIn: async () => PRO,
    logOut: async () => PRO,
    recoverPurchases: async () => PRO,
    onCustomerInfoChanged: () => () => {
      unsubscribed.push(1)
    },
    ...purchases,
  }

  const deps: PurchasesBootstrapDeps = {
    purchases: () => port,
    packages: ref<PurchasePackage[]>([]),
    entitlement,
    loading: ref(false),
    ready: ref(false),
    onCustomerInfo: () => undefined,
    registerAuthWatch: () => {
      if (options.authWatchFails) throw options.authWatchFails
      authWatches.push(1)
    },
  }

  return { deps, applied, hydrated, authWatches, calls, unsubscribed }
}

describe("createPurchasesBootstrap — init", () => {
  beforeEach(() => {
    listeners.length = 0
    removed.length = 0
    warnings.length = 0
    addListenerFails = null
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("is ready, with no packages, when the SDK cannot run", async () => {
    const h = harness({ available: false })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.deps.ready.value).toBe(true)
    expect(h.deps.packages.value).toEqual([])
    expect(h.calls).toEqual([])
  })

  it("shows the cached entitlement before the SDK round-trip", async () => {
    const h = harness({ available: true })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.hydrated).toEqual([0])
    expect(h.calls[0]).toBe("configure")
  })

  it("lands packages, entitlement, the auth watch and ready", async () => {
    const h = harness({
      available: true,
      listPackages: async () => [pkg("$rc_monthly")],
    })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.deps.packages.value.map((p) => p.packageId)).toEqual(["$rc_monthly"])
    expect(h.applied).toEqual([PRO])
    expect(h.authWatches).toEqual([1])
    expect(h.deps.ready.value).toBe(true)
    expect(h.deps.loading.value).toBe(false)
  })

  it("registers the listeners only once when two callers race", async () => {
    let configures = 0
    const h = harness({
      available: true,
      configure: async () => {
        configures += 1
      },
    })
    const bootstrap = createPurchasesBootstrap(h.deps)

    await Promise.all([bootstrap.init(), bootstrap.init()])

    expect(configures).toBe(1)
    expect(listeners).toHaveLength(1)
  })

  it("does nothing on a later init once ready", async () => {
    const h = harness({ available: true })
    const bootstrap = createPurchasesBootstrap(h.deps)

    await bootstrap.init()
    const after = h.calls.length
    await bootstrap.init()

    expect(h.calls).toHaveLength(after)
  })

  it("keeps the cached entitlement when the customer fetch fails", async () => {
    const h = harness({
      available: true,
      listPackages: async () => [pkg("$rc_monthly")],
      getCustomerState: async () => {
        throw new Error("offline")
      },
    })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.applied).toEqual([])
    expect(h.deps.packages.value).toHaveLength(1)
    expect(h.deps.ready.value).toBe(true)
  })

  it("keeps the entitlement when the offerings fetch fails", async () => {
    const h = harness({
      available: true,
      listPackages: async () => {
        throw new Error("timeout")
      },
    })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.deps.packages.value).toEqual([])
    expect(h.applied).toEqual([PRO])
    expect(warnings).toEqual([])
  })

  it("reports an empty offering set as a watchable warning", async () => {
    const h = harness({
      available: true,
      listPackages: async () => {
        throw new RcError("23")
      },
    })

    await createPurchasesBootstrap(h.deps).init()

    expect(warnings).toEqual([{ scope: "purchases", context: { at: "init" } }])
  })

  it("becomes ready even when configure throws", async () => {
    const h = harness({
      available: true,
      configure: async () => {
        throw new Error("bad api key")
      },
    })

    await expect(createPurchasesBootstrap(h.deps).init()).rejects.toThrow("bad api key")

    expect(h.deps.ready.value).toBe(true)
    expect(h.deps.loading.value).toBe(false)
    expect(h.authWatches).toEqual([1])
  })

  it("becomes ready even when the auth watch registration throws", async () => {
    const h = harness({ available: true }, { authWatchFails: new Error("no auth store") })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.deps.ready.value).toBe(true)
  })

  it("becomes ready even when the resume listener cannot be registered", async () => {
    addListenerFails = new Error("plugin unavailable")
    const h = harness({ available: true })

    await createPurchasesBootstrap(h.deps).init()

    expect(h.deps.ready.value).toBe(true)
    expect(listeners).toEqual([])
  })

  it("treats a failed init as the answer and does not try again", async () => {
    let attempt = 0
    const h = harness({
      available: true,
      configure: async () => {
        attempt += 1
        if (attempt === 1) throw new Error("bad api key")
      },
    })
    const bootstrap = createPurchasesBootstrap(h.deps)

    await expect(bootstrap.init()).rejects.toThrow("bad api key")
    await bootstrap.init()

    expect(attempt).toBe(1)
  })
})

describe("createPurchasesBootstrap — refresh", () => {
  beforeEach(() => {
    listeners.length = 0
    removed.length = 0
    warnings.length = 0
    addListenerFails = null
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("does nothing when the SDK cannot run", async () => {
    const h = harness({ available: false })

    await createPurchasesBootstrap(h.deps).refresh()

    expect(h.calls).toEqual([])
  })

  it("re-fetches the entitlement without re-fetching a populated paywall", async () => {
    const h = harness({ available: true, listPackages: async () => [pkg("$rc_monthly")] })
    const bootstrap = createPurchasesBootstrap(h.deps)
    await bootstrap.init()
    const before = h.calls.filter((c) => c === "listPackages").length

    await bootstrap.refresh()

    expect(h.calls.filter((c) => c === "listPackages")).toHaveLength(before)
    expect(h.applied).toEqual([PRO, PRO])
  })

  it("self-heals an empty paywall on resume", async () => {
    let packages: PurchasePackage[] = []
    const h = harness({ available: true, listPackages: async () => packages })
    const bootstrap = createPurchasesBootstrap(h.deps)
    await bootstrap.init()
    expect(h.deps.packages.value).toEqual([])

    packages = [pkg("$rc_annual")]
    await bootstrap.refresh()

    expect(h.deps.packages.value.map((p) => p.packageId)).toEqual(["$rc_annual"])
  })

  it("reports an empty offering set seen on refresh separately from init", async () => {
    const h = harness({
      available: true,
      listPackages: async () => {
        throw new RcError("23")
      },
    })
    const bootstrap = createPurchasesBootstrap(h.deps)
    await bootstrap.init()
    warnings.length = 0

    await bootstrap.refresh()

    expect(warnings).toEqual([{ scope: "purchases", context: { at: "refresh" } }])
  })

  it("survives a failed entitlement re-fetch", async () => {
    let fail = false
    const h = harness({
      available: true,
      listPackages: async () => [pkg("$rc_monthly")],
      getCustomerState: async () => {
        if (fail) throw new Error("offline")
        return PRO
      },
    })
    const bootstrap = createPurchasesBootstrap(h.deps)
    await bootstrap.init()

    fail = true
    await expect(bootstrap.refresh()).resolves.toBeUndefined()
    expect(h.applied).toEqual([PRO])
  })

  it("refreshes when the app comes back to the foreground, not when it leaves", async () => {
    const h = harness({ available: true, listPackages: async () => [pkg("$rc_monthly")] })
    await createPurchasesBootstrap(h.deps).init()

    listeners[0]({ isActive: false })
    await Promise.resolve()
    expect(h.applied).toEqual([PRO])

    listeners[0]({ isActive: true })
    await vi.waitFor(() => expect(h.applied).toHaveLength(2))
  })
})

describe("createPurchasesBootstrap — stopListeners", () => {
  beforeEach(() => {
    listeners.length = 0
    removed.length = 0
    addListenerFails = null
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("drops both listeners it registered, and is safe to call twice", async () => {
    const h = harness({ available: true })
    const bootstrap = createPurchasesBootstrap(h.deps)
    await bootstrap.init()

    bootstrap.stopListeners()
    await vi.waitFor(() => expect(removed).toEqual([0]))
    expect(h.unsubscribed).toEqual([1])

    expect(() => bootstrap.stopListeners()).not.toThrow()
    expect(h.unsubscribed).toEqual([1])
  })

  it("is safe before anything was registered", () => {
    const h = harness({ available: false })

    expect(() => createPurchasesBootstrap(h.deps).stopListeners()).not.toThrow()
  })
})
