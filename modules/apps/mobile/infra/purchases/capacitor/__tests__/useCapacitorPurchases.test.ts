import { beforeEach, describe, expect, it, vi } from "vitest"

import { PurchaseCancelledError, PurchaseNotAllowedError } from "@ports/app/purchases.js"

let platform = "android"

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform, registerPlugin: () => ({}) },
  registerPlugin: () => ({}),
}))

const sdk = vi.hoisted(() => ({
  setLogLevel: vi.fn(),
  configure: vi.fn(),
  getOfferings: vi.fn(),
  getCustomerInfo: vi.fn(),
  purchasePackage: vi.fn(),
  restorePurchases: vi.fn(),
  syncPurchases: vi.fn(),
  logIn: vi.fn(),
  logOut: vi.fn(),
  checkTrialOrIntroductoryPriceEligibility: vi.fn(),
  addCustomerInfoUpdateListener: vi.fn(),
  removeCustomerInfoUpdateListener: vi.fn(),
}))

vi.mock("@revenuecat/purchases-capacitor", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@revenuecat/purchases-capacitor")
  return { ...actual, Purchases: sdk }
})

import {
  INTRO_ELIGIBILITY_STATUS,
  PACKAGE_TYPE,
  PRODUCT_TYPE,
  PURCHASES_ERROR_CODE,
  VERIFICATION_RESULT,
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesOffering,
  type PurchasesPackage,
  type PurchasesStoreProduct,
} from "@revenuecat/purchases-capacitor"

import { useCapacitorPurchases } from "../useCapacitorPurchases.js"

const KEYS = { iosApiKey: "appl_key", androidApiKey: "goog_key" }

function makeProduct(identifier: string, withTrial = false): PurchasesStoreProduct {
  return {
    identifier,
    description: "Everything unlocked",
    title: "Pro",
    price: 29.99,
    priceString: "$29.99",
    pricePerWeek: null,
    pricePerMonth: null,
    pricePerYear: null,
    pricePerWeekString: null,
    pricePerMonthString: null,
    pricePerYearString: null,
    currencyCode: "USD",
    introPrice: withTrial
      ? {
          price: 0,
          priceString: "Free",
          period: "P7D",
          cycles: 1,
          periodUnit: "DAY",
          periodNumberOfUnits: 7,
        }
      : null,
    discounts: null,
    productCategory: null,
    productType: PRODUCT_TYPE.AUTO_RENEWABLE_SUBSCRIPTION,
    subscriptionPeriod: "P1Y",
    defaultOption: null,
    subscriptionOptions: null,
    presentedOfferingIdentifier: null,
    presentedOfferingContext: null,
  }
}

function makePackage(identifier: string, productId: string, withTrial = false): PurchasesPackage {
  return {
    identifier,
    packageType: PACKAGE_TYPE.ANNUAL,
    product: makeProduct(productId, withTrial),
    offeringIdentifier: "default",
    presentedOfferingContext: {
      offeringIdentifier: "default",
      placementIdentifier: null,
      targetingContext: null,
    },
    webCheckoutUrl: null,
  }
}

function makeOffering(packages: PurchasesPackage[]): PurchasesOffering {
  return {
    identifier: "default",
    serverDescription: "Default offering",
    metadata: {},
    availablePackages: packages,
    lifetime: null,
    annual: packages[0] ?? null,
    sixMonth: null,
    threeMonth: null,
    twoMonth: null,
    monthly: null,
    weekly: null,
    webCheckoutUrl: null,
  }
}

function makeEntitlement(
  identifier: string,
  productIdentifier: string,
  expirationDateMillis: number | null
): PurchasesEntitlementInfo {
  return {
    identifier,
    isActive: true,
    willRenew: true,
    periodType: "NORMAL",
    latestPurchaseDate: "2026-01-01T00:00:00Z",
    latestPurchaseDateMillis: Date.UTC(2026, 0, 1),
    originalPurchaseDate: "2026-01-01T00:00:00Z",
    originalPurchaseDateMillis: Date.UTC(2026, 0, 1),
    expirationDate:
      expirationDateMillis === null ? null : new Date(expirationDateMillis).toISOString(),
    expirationDateMillis,
    store: "PLAY_STORE",
    productIdentifier,
    productPlanIdentifier: null,
    isSandbox: false,
    unsubscribeDetectedAt: null,
    unsubscribeDetectedAtMillis: null,
    billingIssueDetectedAt: null,
    billingIssueDetectedAtMillis: null,
    ownershipType: "PURCHASED",
    verification: VERIFICATION_RESULT.NOT_REQUESTED,
  }
}

function makeCustomerInfo(
  active: Record<string, PurchasesEntitlementInfo> = {},
  overrides: { managementURL?: string | null; originalAppUserId?: string } = {}
): CustomerInfo {
  return {
    entitlements: { all: active, active, verification: VERIFICATION_RESULT.NOT_REQUESTED },
    activeSubscriptions: Object.values(active).map((e) => e.productIdentifier),
    allPurchasedProductIdentifiers: [],
    latestExpirationDate: null,
    firstSeen: "2026-01-01T00:00:00Z",
    originalAppUserId: overrides.originalAppUserId ?? "$RCAnonymousID:abc",
    requestDate: "2026-01-01T00:00:00Z",
    allExpirationDates: {},
    allPurchaseDates: {},
    originalApplicationVersion: null,
    originalPurchaseDate: null,
    managementURL: overrides.managementURL ?? null,
    nonSubscriptionTransactions: [],
    subscriptionsByProductIdentifier: {},
  }
}

const PRO = makeEntitlement("pro", "pro_yearly", null)

beforeEach(() => {
  platform = "android"
  for (const fn of Object.values(sdk)) fn.mockReset()
  sdk.setLogLevel.mockResolvedValue(undefined)
  sdk.configure.mockResolvedValue(undefined)
  sdk.getOfferings.mockResolvedValue({
    current: makeOffering([makePackage("$rc_annual", "pro_yearly")]),
    all: { default: makeOffering([]) },
  })
  sdk.getCustomerInfo.mockResolvedValue({ customerInfo: makeCustomerInfo() })
  sdk.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({})
})

describe("useCapacitorPurchases — availability", () => {
  it("is unavailable in the browser, where there is no store", async () => {
    platform = "web"
    const purchases = useCapacitorPurchases(KEYS)

    expect(purchases.available).toBe(false)
    expect(await purchases.listPackages()).toEqual([])
    expect(sdk.configure).not.toHaveBeenCalled()
  })

  it("is unavailable on a native build with no key for the platform", () => {
    platform = "ios"

    expect(useCapacitorPurchases({ iosApiKey: "", androidApiKey: "goog" }).available).toBe(false)
  })

  it("hands back an empty customer state rather than calling an unconfigured SDK", async () => {
    platform = "web"
    const purchases = useCapacitorPurchases(KEYS)

    expect(await purchases.getCustomerState()).toEqual({
      activePackageId: undefined,
      activeEntitlements: [],
      managementUrl: undefined,
      appUserId: undefined,
    })
    expect(await purchases.logIn("user-1")).toEqual(await purchases.logOut())
    expect(await purchases.recoverPurchases()).toEqual(await purchases.getCustomerState())
  })

  it("subscribes to nothing on web, and unsubscribing is harmless", () => {
    platform = "web"
    const unsubscribe = useCapacitorPurchases(KEYS).onCustomerInfoChanged(() => {})

    expect(() => unsubscribe()).not.toThrow()
    expect(sdk.addCustomerInfoUpdateListener).not.toHaveBeenCalled()
  })
})

describe("useCapacitorPurchases — configuration", () => {
  it("configures the SDK with the platform's own key", async () => {
    platform = "ios"

    await useCapacitorPurchases(KEYS).configure()

    expect(sdk.configure).toHaveBeenCalledWith({ apiKey: "appl_key", appUserID: null })
  })

  it("configures once across many calls", async () => {
    const purchases = useCapacitorPurchases(KEYS)

    await purchases.configure()
    await purchases.listPackages()
    await purchases.getCustomerState()

    expect(sdk.configure).toHaveBeenCalledTimes(1)
  })

  it("raises a failed configure and allows a later retry", async () => {
    sdk.configure.mockRejectedValueOnce(new Error("bad key"))
    const purchases = useCapacitorPurchases(KEYS)

    await expect(purchases.configure()).rejects.toThrow("bad key")

    // A failure that latched `configured` would leave the app permanently
    // unable to sell anything until it restarts.
    await purchases.configure()
    expect(sdk.configure).toHaveBeenCalledTimes(2)
  })
})

describe("useCapacitorPurchases — listPackages", () => {
  it("maps the current offering onto the port's package shape", async () => {
    const packages = await useCapacitorPurchases(KEYS).listPackages()

    expect(packages).toEqual([
      {
        packageId: "$rc_annual",
        productId: "pro_yearly",
        title: "Pro",
        description: "Everything unlocked",
        priceString: "$29.99",
        billingPeriod: "P1Y",
        introOffer: undefined,
      },
    ])
  })

  it("returns nothing when the account has no current offering", async () => {
    sdk.getOfferings.mockResolvedValue({ current: null, all: {} })

    expect(await useCapacitorPurchases(KEYS).listPackages()).toEqual([])
  })

  it("advertises a trial on android without asking about eligibility", async () => {
    sdk.getOfferings.mockResolvedValue({
      current: makeOffering([makePackage("$rc_annual", "pro_yearly", true)]),
      all: {},
    })

    const [pkg] = await useCapacitorPurchases(KEYS).listPackages()

    expect(pkg.introOffer).toEqual({
      isFree: true,
      priceString: "Free",
      periodUnit: "DAY",
      periodNumberOfUnits: 7,
    })
    expect(sdk.checkTrialOrIntroductoryPriceEligibility).not.toHaveBeenCalled()
  })

  it("hides the trial from an iOS customer who has already used it", async () => {
    platform = "ios"
    sdk.getOfferings.mockResolvedValue({
      current: makeOffering([makePackage("$rc_annual", "pro_yearly", true)]),
      all: {},
    })
    sdk.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      pro_yearly: { status: INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE },
    })

    const [pkg] = await useCapacitorPurchases(KEYS).listPackages()

    // Advertising "free" here gets the customer charged full price at once.
    expect(pkg.introOffer).toBeUndefined()
  })

  it("shows the trial to an eligible iOS customer", async () => {
    platform = "ios"
    sdk.getOfferings.mockResolvedValue({
      current: makeOffering([makePackage("$rc_annual", "pro_yearly", true)]),
      all: {},
    })
    sdk.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      pro_yearly: { status: INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE },
    })

    const [pkg] = await useCapacitorPurchases(KEYS).listPackages()

    expect(pkg.introOffer?.isFree).toBe(true)
  })
})

describe("useCapacitorPurchases — purchase", () => {
  it("returns the customer state the store answered with", async () => {
    sdk.purchasePackage.mockResolvedValue({
      customerInfo: makeCustomerInfo({ pro: PRO }, { managementURL: "https://play/manage" }),
    })

    const state = await useCapacitorPurchases(KEYS).purchase("$rc_annual")

    expect(state).toEqual({
      activePackageId: "$rc_annual",
      activeEntitlements: ["pro"],
      managementUrl: "https://play/manage",
      appUserId: "$RCAnonymousID:abc",
    })
  })

  it("refuses a package the current offering does not sell", async () => {
    await expect(useCapacitorPurchases(KEYS).purchase("$rc_monthly")).rejects.toThrow(
      "Package not found: $rc_monthly"
    )
    expect(sdk.purchasePackage).not.toHaveBeenCalled()
  })

  it("reports a dismissed dialog as a cancellation, not a failure", async () => {
    sdk.purchasePackage.mockRejectedValue({
      code: PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR,
    })

    await expect(useCapacitorPurchases(KEYS).purchase("$rc_annual")).rejects.toBeInstanceOf(
      PurchaseCancelledError
    )
  })

  it("reports a store refusal as its own typed condition", async () => {
    sdk.purchasePackage.mockRejectedValue({
      code: PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR,
    })

    await expect(useCapacitorPurchases(KEYS).purchase("$rc_annual")).rejects.toBeInstanceOf(
      PurchaseNotAllowedError
    )
  })

  it("lets an unrecognised store failure through untranslated", async () => {
    sdk.purchasePackage.mockRejectedValue(new Error("network down"))

    await expect(useCapacitorPurchases(KEYS).purchase("$rc_annual")).rejects.toThrow("network down")
  })
})

describe("useCapacitorPurchases — restore and recovery", () => {
  it("restores through the store's own purchase history", async () => {
    sdk.restorePurchases.mockResolvedValue({ customerInfo: makeCustomerInfo({ pro: PRO }) })

    expect((await useCapacitorPurchases(KEYS).restore()).activeEntitlements).toEqual(["pro"])
  })

  it("recovers silently on android, without an OS prompt", async () => {
    sdk.restorePurchases.mockResolvedValue({ customerInfo: makeCustomerInfo({ pro: PRO }) })

    await useCapacitorPurchases(KEYS).recoverPurchases()

    expect(sdk.syncPurchases).not.toHaveBeenCalled()
    expect(sdk.restorePurchases).toHaveBeenCalledTimes(1)
  })

  it("recovers on iOS without raising the App Store sign-in sheet", async () => {
    platform = "ios"
    sdk.syncPurchases.mockResolvedValue(undefined)
    sdk.getCustomerInfo.mockResolvedValue({ customerInfo: makeCustomerInfo({ pro: PRO }) })

    const state = await useCapacitorPurchases(KEYS).recoverPurchases()

    // restorePurchases prompts for an Apple ID; an automatic call must not.
    expect(sdk.restorePurchases).not.toHaveBeenCalled()
    expect(state.activeEntitlements).toEqual(["pro"])
  })
})

describe("useCapacitorPurchases — identity", () => {
  it("binds the install to the app's own user id", async () => {
    sdk.logIn.mockResolvedValue({
      customerInfo: makeCustomerInfo({ pro: PRO }, { originalAppUserId: "user-1" }),
      created: false,
    })

    const state = await useCapacitorPurchases(KEYS).logIn("user-1")

    expect(sdk.logIn).toHaveBeenCalledWith({ appUserID: "user-1" })
    expect(state.appUserId).toBe("user-1")
  })

  it("drops back to an anonymous customer on sign-out", async () => {
    sdk.logOut.mockResolvedValue({
      customerInfo: makeCustomerInfo({}, { originalAppUserId: "$RCAnonymousID:fresh" }),
    })

    const state = await useCapacitorPurchases(KEYS).logOut()

    expect(state.activeEntitlements).toEqual([])
    expect(state.appUserId).toBe("$RCAnonymousID:fresh")
  })
})

describe("useCapacitorPurchases — customer info subscription", () => {
  it("delivers a mapped state to the listener when the store pushes an update", async () => {
    let push: ((info: CustomerInfo) => void) | undefined
    sdk.addCustomerInfoUpdateListener.mockImplementation((cb: (info: CustomerInfo) => void) => {
      push = cb
      return Promise.resolve("callback-1")
    })
    const seen: string[][] = []

    useCapacitorPurchases(KEYS).onCustomerInfoChanged((state) =>
      seen.push(state.activeEntitlements)
    )
    push?.(makeCustomerInfo({ pro: PRO }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    expect(seen[0]).toEqual(["pro"])
  })

  it("removes the listener by the id the SDK handed back", async () => {
    sdk.addCustomerInfoUpdateListener.mockResolvedValue("callback-1")
    sdk.removeCustomerInfoUpdateListener.mockResolvedValue(undefined)

    useCapacitorPurchases(KEYS).onCustomerInfoChanged(() => {})()

    // A handle-shaped removal is a silent no-op and leaks on every remount.
    await vi.waitFor(() =>
      expect(sdk.removeCustomerInfoUpdateListener).toHaveBeenCalledWith({
        listenerToRemove: "callback-1",
      })
    )
  })

  it("survives a removal the SDK rejects", async () => {
    sdk.addCustomerInfoUpdateListener.mockResolvedValue("callback-1")
    sdk.removeCustomerInfoUpdateListener.mockRejectedValue(new Error("already gone"))

    expect(() => useCapacitorPurchases(KEYS).onCustomerInfoChanged(() => {})()).not.toThrow()
  })
})
