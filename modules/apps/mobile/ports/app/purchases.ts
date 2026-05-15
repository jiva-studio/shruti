/**
 * Port for in-app purchases / subscriptions. Backed by RevenueCat on
 * native, no-op on web. The native SDK is the single source of truth
 * for entitlement state — the app does not persist subscription status
 * itself, so a restore after reinstall comes back through
 * Apple ID / Google Account-scoped RevenueCat data.
 */

export interface PurchasePackage {
  packageId: string
  productId: string
  title: string
  description: string
  priceString: string
  /** ISO-8601 period (e.g. `P1M`, `P1Y`). Empty string when unknown. */
  billingPeriod: string
}

export interface CustomerState {
  activePackageId: string | undefined
  activeEntitlements: string[]
  /** Store-side subscription-management URL (Play / App Store). */
  managementUrl: string | undefined
}

export type CustomerInfoListener = (state: CustomerState) => void

/**
 * Thrown by `IPurchases.purchase` when the user dismisses the native
 * purchase dialog. Callers usually want to swallow it silently.
 */
export class PurchaseCancelledError extends Error {
  constructor(message = "Purchase cancelled by user") {
    super(message)
    this.name = "PurchaseCancelledError"
  }
}

export interface IPurchases {
  /**
   * `true` on iOS / Android when the SDK can run (API key present).
   * `false` on web or when no key is configured at build time.
   */
  readonly available: boolean

  configure(): Promise<void>
  listPackages(): Promise<PurchasePackage[]>
  getCustomerState(): Promise<CustomerState>
  purchase(packageId: string): Promise<CustomerState>
  restore(): Promise<CustomerState>
  onCustomerInfoChanged(listener: CustomerInfoListener): () => void
}
