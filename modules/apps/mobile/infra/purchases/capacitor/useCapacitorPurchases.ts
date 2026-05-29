import { Capacitor } from "@capacitor/core"
import {
  Purchases,
  PURCHASES_ERROR_CODE,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor"
import {
  PurchaseCancelledError,
  type CustomerInfoListener,
  type CustomerState,
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
      return current.availablePackages.map(toPurchasePackage)
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
      const handlePromise = Purchases.addCustomerInfoUpdateListener((info) => {
        void toCustomerState(info).then(listener)
      })
      return () => {
        void Promise.resolve(handlePromise).then((handle) => {
          ;(handle as { remove?: () => Promise<void> } | undefined)?.remove?.()
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

function toPurchasePackage(pkg: PurchasesPackage): PurchasePackage {
  return {
    packageId: pkg.identifier,
    productId: pkg.product.identifier,
    title: pkg.product.title,
    description: pkg.product.description,
    priceString: pkg.product.priceString,
    billingPeriod: pkg.product.subscriptionPeriod ?? "",
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
  const activeEnt =
    activeEntitlements.length > 0 ? info.entitlements.active[activeEntitlements[0]] : undefined
  const activeProductId = activeEnt?.productIdentifier

  let activePackageId: string | undefined
  if (activeProductId) {
    try {
      const offerings = await Purchases.getOfferings()
      const pkg = offerings.current?.availablePackages.find(
        (p) => p.product.identifier === activeProductId
      )
      activePackageId = pkg?.identifier
    } catch {
      // Offerings unavailable — leave package unresolved.
    }
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
