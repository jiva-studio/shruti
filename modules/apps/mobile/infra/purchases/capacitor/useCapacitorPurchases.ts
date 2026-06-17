import { Capacitor } from "@capacitor/core"
import {
  Purchases,
  PURCHASES_ERROR_CODE,
  LOG_LEVEL,
  INTRO_ELIGIBILITY_STATUS,
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor"
import {
  PurchaseCancelledError,
  type CustomerInfoListener,
  type CustomerState,
  type IntroOffer,
  type IPurchases,
  type PurchasePackage,
} from "@ports/app/purchases.js"

const ANDROID_APP_ID = "studio.jiva.shruti"

export interface CapacitorPurchasesConfig {
  iosApiKey: string
  androidApiKey: string
}

export function useCapacitorPurchases(cfg: CapacitorPurchasesConfig): IPurchases {
  const platform = Capacitor.getPlatform()
  const apiKey =
    platform === "ios" ? cfg.iosApiKey : platform === "android" ? cfg.androidApiKey : ""
  const available = platform !== "web" && apiKey.length > 0
  let configured = false

  async function ensureConfigured(): Promise<void> {
    if (!available || configured) return
    configured = true
    try {
      // DEBUG until we trust the new wiring on iOS — prints
      // `[Purchases] - DEBUG - Fetching offerings ...` and the
      // exact reason when a request fails. Bump back to WARN once
      // we've shipped a working build.
      await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG })
      // `appUserID: null` → RC mints an anonymous id keyed to the
      // install. `restorePurchases()` rebinds it to the Apple / Google
      // account's purchase history — that's the cross-install path.
      await Purchases.configure({ apiKey, appUserID: null })

      console.log(
        "[purchases] configure ok",
        `platform=${platform}`,
        `apiKey=${apiKey.slice(0, 8)}…`
      )
    } catch (e) {
      configured = false

      console.error("[purchases] configure failed", e)
      throw e
    }
  }

  return {
    available,

    async configure() {
      await ensureConfigured()
    },

    async listPackages() {
      if (!available) return []
      await ensureConfigured()
      const offerings = await Purchases.getOfferings()
      const current = offerings.current

      console.log(
        "[purchases] offerings",
        `currentId=${current?.identifier ?? "null"}`,
        `packageCount=${current?.availablePackages.length ?? 0}`,
        `allOfferings=${Object.keys(offerings.all).join(",")}`
      )
      if (!current) return []
      // iOS reports whether the customer can still use a product's intro
      // offer (a used-up trial would be charged full price immediately, so
      // we must not advertise "free" to those users). Android always
      // returns UNKNOWN, so there we fall back to the intro phase being
      // present on the product — Google enforces new-customer eligibility
      // at purchase time.
      const eligible = await introEligibility(
        platform === "ios" ? current.availablePackages.map((p) => p.product.identifier) : []
      )
      return current.availablePackages.map((pkg) =>
        toPurchasePackage(
          pkg,
          platform === "ios" ? eligible[pkg.product.identifier] === true : true
        )
      )
    },

    async getCustomerState() {
      if (!available) return EMPTY_STATE
      await ensureConfigured()
      const result = await Purchases.getCustomerInfo()

      console.log(
        "[purchases] customer",
        `id=${result.customerInfo.originalAppUserId}`,
        `entitlements=${Object.keys(result.customerInfo.entitlements.active).join(",") || "none"}`,
        `activeSubs=${(result.customerInfo.activeSubscriptions ?? []).join(",") || "none"}`
      )
      return await toCustomerState(result.customerInfo)
    },

    async purchase(packageId) {
      await ensureConfigured()
      const offerings = await Purchases.getOfferings()
      const aPackage = offerings.current?.availablePackages.find((p) => p.identifier === packageId)
      if (!aPackage) throw new Error(`Package not found: ${packageId}`)
      try {
        const result = await Purchases.purchasePackage({ aPackage })
        return await toCustomerState(result.customerInfo)
      } catch (e) {
        const err = e as { code?: string }
        if (err?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
          throw new PurchaseCancelledError()
        }
        throw e
      }
    },

    async restore() {
      await ensureConfigured()
      const result = await Purchases.restorePurchases()
      return await toCustomerState(result.customerInfo)
    },

    async recoverPurchases() {
      if (!available) return EMPTY_STATE
      await ensureConfigured()
      // Android: restorePurchases is silent (no OS prompt) and is RC's
      // recommended, more reliable recovery path. iOS: restorePurchases
      // can raise an App Store sign-in sheet, so use the silent
      // syncPurchases for this automatic call — the Apple-mandated
      // manual Restore button (restore()) covers the robust iOS case.
      if (Capacitor.getPlatform() === "ios") {
        await Purchases.syncPurchases()
        const synced = await Purchases.getCustomerInfo()
        return await toCustomerState(synced.customerInfo)
      }
      const result = await Purchases.restorePurchases()
      return await toCustomerState(result.customerInfo)
    },

    async logIn(appUserId: string) {
      if (!available) return EMPTY_STATE
      await ensureConfigured()
      const result = await Purchases.logIn({ appUserID: appUserId })
      console.log("[purchases] logIn", `appUserId=${appUserId}`, `created=${result.created}`)
      return await toCustomerState(result.customerInfo)
    },

    async logOut() {
      if (!available) return EMPTY_STATE
      await ensureConfigured()
      const result = await Purchases.logOut()
      console.log("[purchases] logOut")
      return await toCustomerState(result.customerInfo)
    },

    onCustomerInfoChanged(listener: CustomerInfoListener) {
      if (!available) return NOOP_UNSUB
      // `addCustomerInfoUpdateListener` resolves to a `PurchasesCallbackId`
      // (a plain string), NOT a removable handle object — so the old
      // `handle?.remove?.()` was always a silent no-op and the listener
      // leaked on every mount/unmount. Remove it by its callback id via
      // `removeCustomerInfoUpdateListener`.
      const idPromise = Purchases.addCustomerInfoUpdateListener((info) => {
        void toCustomerState(info).then(listener)
      })
      return () => {
        void idPromise
          .then((listenerToRemove) =>
            Purchases.removeCustomerInfoUpdateListener({ listenerToRemove })
          )
          .catch((e) => {
            console.warn("[purchases] failed to remove customer info listener", e)
          })
      }
    },
  }
}

const EMPTY_STATE: CustomerState = {
  activePackageId: undefined,
  activeEntitlements: [],
  managementUrl: undefined,
  appUserId: undefined,
}

const NOOP_UNSUB = (): void => {}

/**
 * Maps an RC package to our port shape. `showIntro` gates whether the
 * product's intro phase (the free trial) is surfaced — the caller passes
 * `false` for iOS customers RC reports as ineligible so we never advertise
 * a trial the App Store would charge for immediately.
 */
function toPurchasePackage(pkg: PurchasesPackage, showIntro: boolean): PurchasePackage {
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
async function introEligibility(productIds: string[]): Promise<Record<string, boolean>> {
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

async function toCustomerState(info: CustomerInfo): Promise<CustomerState> {
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
