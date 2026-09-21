import { Capacitor } from "@capacitor/core"
import { Purchases, PURCHASES_ERROR_CODE, LOG_LEVEL } from "@revenuecat/purchases-capacitor"
import {
  PurchaseCancelledError,
  PurchaseNotAllowedError,
  type CustomerInfoListener,
  type IPurchases,
} from "@ports/app/purchases.js"
import {
  EMPTY_STATE,
  introEligibility,
  NOOP_UNSUB,
  toCustomerState,
  toPurchasePackage,
} from "./revenueCatMapping.js"

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
        // Store refused the purchase for the device/account (IAP disabled on
        // this test track, parental restrictions, unsupported region) — an
        // expected store condition, not an app fault. Map it to a typed error
        // the caller shows calmly and crash-reporting ignores.
        if (err?.code === PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR) {
          throw new PurchaseNotAllowedError()
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
