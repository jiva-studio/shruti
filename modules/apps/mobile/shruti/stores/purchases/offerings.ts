import type { PurchasePackage } from "@ports/app/purchases.js"

/**
 * RevenueCat CONFIGURATION_ERROR (code "23"): no dashboard product could be
 * fetched from the store. Benign for the user and normal for store reviewers,
 * sandbox accounts and builds without provisioned products — but a store-wide
 * outage if it starts happening broadly, so the caller reports it at warning
 * level rather than silencing it.
 */
export function isEmptyOfferingsError(e: unknown): boolean {
  return (
    typeof (e as { code?: unknown })?.code === "string" && (e as { code: string }).code === "23"
  )
}

/** Sample packages for dev/preview builds, where RevenueCat has no offerings.
 *  The standard Rc package ids make the footer resolve localized plan names. */
export function devMockPackages(): PurchasePackage[] {
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
