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
  /**
   * RevenueCat-side customer id (anonymous `$RCAnonymousID:…` unless the
   * app explicitly logs the user in). Surfaced in the debug footer so
   * we can look the customer up in the RC dashboard.
   */
  appUserId: string | undefined
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
  /**
   * Bind the install to a stable app user id (our JWT `sub`). RC will
   * alias the current anonymous `$RCAnonymousID:…` to the new id and
   * emit a `SUBSCRIBER_ALIAS` webhook so the server can reconcile
   * pre-login purchases to the now-signed-in account.
   */
  logIn(appUserId: string): Promise<CustomerState>
  /**
   * Silently re-attach this device's store purchases to the currently
   * signed-in app user id. Used to recover a purchase stranded on a
   * previous (anonymous) id when `logIn` hit RC's "no merge" branch —
   * i.e. the user bought before signing in, then signed into an account
   * RC already knew (reinstall / account recreate). For an anon-owned
   * receipt RC aliases the anonymous id into the current one regardless
   * of the dashboard transfer-behavior setting. Adapter picks the
   * platform-appropriate, non-prompting SDK call.
   */
  recoverPurchases(): Promise<CustomerState>
  /**
   * Drop the install back to an anonymous id. Called when the user
   * signs out; subsequent purchases are scoped to a fresh anon id.
   */
  logOut(): Promise<CustomerState>
  onCustomerInfoChanged(listener: CustomerInfoListener): () => void
}
