import { Capacitor } from "@capacitor/core"
import {
  Purchases,
  INTRO_ELIGIBILITY_STATUS,
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor"
import type { CustomerState, IntroOffer, PurchasePackage } from "@ports/app/purchases.js"

const ANDROID_APP_ID = "studio.jiva.shruti"

export const EMPTY_STATE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: undefined,
}

export const NOOP_UNSUB = (): void => {}

/**
 * Maps an RC package to our port shape. `showIntro` gates whether the
 * product's intro phase (the free trial) is surfaced — the caller passes
 * `false` for iOS customers RC reports as ineligible so we never advertise
 * a trial the App Store would charge for immediately.
 */
export function toPurchasePackage(pkg: PurchasesPackage, showIntro: boolean): PurchasePackage {
  const intro = pkg.product.introPrice
  const introOffer: IntroOffer | undefined =
    showIntro && intro
      ? {
          isFree: intro.price === 0,
          priceString: intro.priceString,
          periodUnit: intro.periodUnit,
          periodNumberOfUnits: intro.periodNumberOfUnits,
        }
      : undefined
  return {
    packageId: pkg.identifier,
    productId: pkg.product.identifier,
    title: pkg.product.title,
    description: pkg.product.description,
    priceString: pkg.product.priceString,
    billingPeriod: pkg.product.subscriptionPeriod ?? "",
    introOffer,
  }
}

/**
 * iOS-only intro-offer eligibility per product id, mapped to a plain
 * "is eligible" boolean. Only `ELIGIBLE` counts: RC's own guidance is to
 * show the regular price on `UNKNOWN` rather than risk a misleading trial
 * badge. Never rejects — on failure we return an empty map and the caller
 * treats every product as not-eligible.
 */
export async function introEligibility(productIds: string[]): Promise<Record<string, boolean>> {
  if (productIds.length === 0) return {}
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility({
      productIdentifiers: productIds,
    })
    const out: Record<string, boolean> = {}
    for (const [id, e] of Object.entries(result)) {
      out[id] = e.status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE
    }
    return out
  } catch (e) {
    console.warn("[purchases] intro eligibility check failed", e)
    return {}
  }
}

export async function toCustomerState(info: CustomerInfo): Promise<CustomerState> {
  // `entitlements.active` is RC's canonical "is this customer entitled
  // right now" signal — it's the only thing that respects expiry. Do
  // NOT fall back to `info.activeSubscriptions`: that list keeps
  // product ids through grace / billing-retry and the sandbox transition
  // window after the final renewal, so it can report a product as
  // "active" after RC backend has already marked the customer expired.
  // If a purchase shows up here but `entitlements.active` is empty,
  // the fix is to attach the product to an Entitlement in the RC
  // dashboard, not to mask it on the client.
  const activeEntitlements = Object.keys(info.entitlements.active)

  // Fetch the current offering once: it both drives the deterministic
  // entitlement pick below and resolves the active package id. Offerings
  // may be unavailable (network / not configured) — tolerate that.
  let currentPackages: PurchasesPackage[] | undefined
  if (activeEntitlements.length > 0) {
    try {
      currentPackages = (await Purchases.getOfferings()).current?.availablePackages
    } catch {
      // Offerings unavailable — entitlement pick falls back to expiry.
    }
  }

  // A customer can hold more than one active entitlement at once (e.g. an
  // RU promotional grant adds a SEPARATE entitlement alongside a paid
  // sub). Picking `active[Object.keys(active)[0]]` is non-deterministic —
  // map key order can flip between calls, resolving `activeProductId` /
  // `managementUrl` to the wrong (or empty) entitlement. Pick
  // deterministically: prefer the entitlement whose product is in the
  // current offering, otherwise the one expiring latest.
  const activeEnt = pickActiveEntitlement(info.entitlements.active, currentPackages)
  const activeProductId = activeEnt?.productIdentifier

  let activePackageId: string | undefined
  if (activeProductId) {
    const pkg = currentPackages?.find((p) => p.product.identifier === activeProductId)
    activePackageId = pkg?.identifier
    // No package match (product not in current offering, or offerings
    // unavailable) — still report the subscription as active using the
    // raw product id; the UI only checks `activePackageId !== undefined`.
    activePackageId ??= activeProductId
  }

  return {
    activePackageId,
    activeEntitlements,
    // RC ships the store-side management URL directly when the
    // customer has an active subscription. Fall back to our
    // hand-built link if it's missing (e.g. lapsed sub).
    managementUrl: info.managementURL ?? getManagementUrl(activeProductId),
    appUserId: info.originalAppUserId,
  }
}

/**
 * Deterministically picks one entitlement from RC's `active` map. The map
 * can hold more than one active entitlement (e.g. a paid sub plus an RU
 * promotional grant), and JS object key order is not a stable selection
 * key. Prefer the entitlement whose product is sold in the current
 * offering — that's the one the app actually surfaces — and otherwise the
 * entitlement expiring latest (a lifetime / non-expiring grant, with
 * `expirationDate === null`, sorts last so it wins as the most durable).
 */
function pickActiveEntitlement(
  active: Record<string, PurchasesEntitlementInfo>,
  currentPackages: PurchasesPackage[] | undefined
): PurchasesEntitlementInfo | undefined {
  const entitlements = Object.values(active)
  if (entitlements.length <= 1) return entitlements[0]

  const offeringProductIds = new Set(currentPackages?.map((p) => p.product.identifier))
  const inOffering = entitlements.filter((e) => offeringProductIds.has(e.productIdentifier))
  const pool = inOffering.length > 0 ? inOffering : entitlements

  return pool.reduce((latest, e) => (expiryRank(e) > expiryRank(latest) ? e : latest))
}

/** Sort key for entitlement durability: a null expiry (lifetime) ranks highest. */
function expiryRank(e: PurchasesEntitlementInfo): number {
  if (e.expirationDateMillis === null) return Number.POSITIVE_INFINITY
  return e.expirationDateMillis
}

function getManagementUrl(productId: string | undefined): string | undefined {
  const platform = Capacitor.getPlatform()
  if (platform === "android") {
    if (!productId) return "https://play.google.com/store/account/subscriptions"
    return (
      "https://play.google.com/store/account/subscriptions" +
      `?sku=${encodeURIComponent(productId)}&package=${ANDROID_APP_ID}`
    )
  }
  if (platform === "ios") return "https://apps.apple.com/account/subscriptions"
  return undefined
}
