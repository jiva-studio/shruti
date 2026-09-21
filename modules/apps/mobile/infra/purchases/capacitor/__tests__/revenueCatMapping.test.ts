import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CustomerInfo,
  PurchasesEntitlementInfo,
  PurchasesPackage,
} from "@revenuecat/purchases-capacitor"

const getOfferingsMock = vi.fn()
const eligibilityMock = vi.fn()
let platform = "android"

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => platform } }))
vi.mock("@revenuecat/purchases-capacitor", () => ({
  INTRO_ELIGIBILITY_STATUS: {
    INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 3,
    INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 2,
    INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0,
  },
  Purchases: {
    getOfferings: () => getOfferingsMock(),
    checkTrialOrIntroductoryPriceEligibility: (a: unknown) => eligibilityMock(a),
  },
}))

const { introEligibility, toCustomerState, toPurchasePackage } =
  await import("../revenueCatMapping.js")

function pkg(over: Record<string, unknown> = {}): PurchasesPackage {
  return {
    identifier: "$rc_annual",
    product: {
      identifier: "pro_yearly",
      title: "Pro (yearly)",
      description: "Everything",
      priceString: "$29.99",
      subscriptionPeriod: "P1Y",
      ...((over.product as Record<string, unknown>) ?? {}),
    },
    ...over,
  } as unknown as PurchasesPackage
}

function entitlement(over: Partial<PurchasesEntitlementInfo>): PurchasesEntitlementInfo {
  return {
    productIdentifier: "pro_yearly",
    expirationDateMillis: null,
    ...over,
  } as PurchasesEntitlementInfo
}

function customer(
  over: Partial<CustomerInfo> & { active?: Record<string, PurchasesEntitlementInfo> }
) {
  return {
    entitlements: { active: over.active ?? {} },
    managementURL: over.managementURL ?? null,
    originalAppUserId: over.originalAppUserId ?? "rc-user",
  } as unknown as CustomerInfo
}

beforeEach(() => {
  platform = "android"
  getOfferingsMock.mockReset().mockResolvedValue({ current: { availablePackages: [] } })
  eligibilityMock.mockReset()
})

describe("toPurchasePackage", () => {
  it("maps the store's package onto the port's shape", () => {
    expect(toPurchasePackage(pkg(), false)).toEqual({
      packageId: "$rc_annual",
      productId: "pro_yearly",
      title: "Pro (yearly)",
      description: "Everything",
      priceString: "$29.99",
      billingPeriod: "P1Y",
      introOffer: undefined,
    })
  })

  it("has no billing period when the store reports none", () => {
    expect(
      toPurchasePackage(pkg({ product: { subscriptionPeriod: null } }), false).billingPeriod
    ).toBe("")
  })

  it("surfaces a free trial as an intro offer", () => {
    const withTrial = pkg({
      product: {
        introPrice: { price: 0, priceString: "Free", periodUnit: "DAY", periodNumberOfUnits: 7 },
      },
    })
    expect(toPurchasePackage(withTrial, true).introOffer).toEqual({
      isFree: true,
      priceString: "Free",
      periodUnit: "DAY",
      periodNumberOfUnits: 7,
    })
  })

  it("marks a discounted intro phase as not free", () => {
    const discounted = pkg({
      product: {
        introPrice: {
          price: 4.99,
          priceString: "$4.99",
          periodUnit: "MONTH",
          periodNumberOfUnits: 1,
        },
      },
    })
    expect(toPurchasePackage(discounted, true).introOffer?.isFree).toBe(false)
  })

  it("never advertises a trial to an ineligible customer", () => {
    const withTrial = pkg({
      product: {
        introPrice: { price: 0, priceString: "Free", periodUnit: "DAY", periodNumberOfUnits: 7 },
      },
    })
    expect(toPurchasePackage(withTrial, false).introOffer).toBeUndefined()
  })
})

describe("introEligibility", () => {
  it("asks nothing when there are no products", async () => {
    expect(await introEligibility([])).toEqual({})
    expect(eligibilityMock).not.toHaveBeenCalled()
  })

  it("counts only an explicitly eligible status", async () => {
    eligibilityMock.mockResolvedValue({
      pro_yearly: { status: 3 },
      pro_monthly: { status: 2 },
      pro_lifetime: { status: 0 },
    })

    expect(await introEligibility(["pro_yearly", "pro_monthly", "pro_lifetime"])).toEqual({
      pro_yearly: true,
      pro_monthly: false,
      pro_lifetime: false,
    })
  })

  it("treats a failed check as nobody being eligible", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    eligibilityMock.mockRejectedValue(new Error("network"))

    expect(await introEligibility(["pro_yearly"])).toEqual({})
    warn.mockRestore()
  })
})

describe("toCustomerState", () => {
  it("reports no subscription for a customer with no active entitlement", async () => {
    const state = await toCustomerState(customer({}))

    expect(state.activePackageId).toBeUndefined()
    expect(state.activeEntitlements).toEqual([])
    expect(getOfferingsMock).not.toHaveBeenCalled()
  })

  it("resolves the active entitlement to the package that sells it", async () => {
    getOfferingsMock.mockResolvedValue({ current: { availablePackages: [pkg()] } })

    const state = await toCustomerState(
      customer({ active: { pro: entitlement({ productIdentifier: "pro_yearly" }) } })
    )

    expect(state.activePackageId).toBe("$rc_annual")
    expect(state.activeEntitlements).toEqual(["pro"])
    expect(state.appUserId).toBe("rc-user")
  })

  it("falls back to the raw product id when the offering does not sell it any more", async () => {
    const state = await toCustomerState(
      customer({ active: { pro: entitlement({ productIdentifier: "legacy_yearly" }) } })
    )

    expect(state.activePackageId).toBe("legacy_yearly")
  })

  it("still reports the subscription when the offerings cannot be fetched", async () => {
    getOfferingsMock.mockRejectedValue(new Error("offline"))

    const state = await toCustomerState(
      customer({ active: { pro: entitlement({ productIdentifier: "pro_yearly" }) } })
    )

    expect(state.activePackageId).toBe("pro_yearly")
  })

  it("prefers the entitlement whose product the app actually sells", async () => {
    getOfferingsMock.mockResolvedValue({ current: { availablePackages: [pkg()] } })

    const state = await toCustomerState(
      customer({
        active: {
          grant: entitlement({ productIdentifier: "ru_promo", expirationDateMillis: 9_000 }),
          paid: entitlement({ productIdentifier: "pro_yearly", expirationDateMillis: 1_000 }),
        },
      })
    )

    expect(state.activePackageId).toBe("$rc_annual")
  })

  it("prefers the entitlement lasting longest when the app sells neither", async () => {
    const state = await toCustomerState(
      customer({
        active: {
          short: entitlement({ productIdentifier: "trial", expirationDateMillis: 1_000 }),
          long: entitlement({ productIdentifier: "annual", expirationDateMillis: 9_000 }),
        },
      })
    )

    expect(state.activePackageId).toBe("annual")
  })

  it("prefers a non-expiring grant over a dated one", async () => {
    const state = await toCustomerState(
      customer({
        active: {
          dated: entitlement({ productIdentifier: "annual", expirationDateMillis: 9_000 }),
          lifetime: entitlement({ productIdentifier: "forever", expirationDateMillis: null }),
        },
      })
    )

    expect(state.activePackageId).toBe("forever")
  })

  it("uses the store's own management url when it ships one", async () => {
    const state = await toCustomerState(
      customer({
        active: { pro: entitlement({}) },
        managementURL: "https://store/manage",
      })
    )

    expect(state.managementUrl).toBe("https://store/manage")
  })

  it("builds a Play Store link for the active product when the store ships none", async () => {
    const state = await toCustomerState(
      customer({ active: { pro: entitlement({ productIdentifier: "pro_yearly" }) } })
    )

    expect(state.managementUrl).toBe(
      "https://play.google.com/store/account/subscriptions?sku=pro_yearly&package=studio.jiva.shruti"
    )
  })

  it("links to the bare subscriptions page for a lapsed customer", async () => {
    expect((await toCustomerState(customer({}))).managementUrl).toBe(
      "https://play.google.com/store/account/subscriptions"
    )

    platform = "ios"
    expect((await toCustomerState(customer({}))).managementUrl).toBe(
      "https://apps.apple.com/account/subscriptions"
    )

    platform = "web"
    expect((await toCustomerState(customer({}))).managementUrl).toBeUndefined()
  })
})
