import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import type { CustomerState, PurchasePackage } from "@ports/app/purchases.js"

/**
 * Reactive view over RevenueCat. State here is derived live from the
 * SDK — `getCustomerInfo` / `purchasePackage` / `restorePurchases`
 * plus the `addCustomerInfoUpdateListener` push channel. Nothing about
 * subscription state is persisted by the app; the reinstall flow
 * relies on `restore()` rebinding the install to the Apple / Google
 * account's purchase history.
 */
export const usePurchasesStore = defineStore("purchases", () => {
  const packages = ref<PurchasePackage[]>([])
  const activePackageId = ref<string | undefined>(undefined)
  const managementUrl = ref<string | undefined>(undefined)
  const loading = ref(false)
  const purchasing = ref(false)
  const restoring = ref(false)
  const ready = ref(false)
  // On-device diagnostic trail. Each step of init / purchase / restore
  // pushes a one-line description; the dialog renders the tail of this
  // ring buffer at the bottom so we can debug without adb on Xiaomi /
  // without a Mac on iOS. Remove once IAP is trusted.
  const debugLog = ref<string[]>([])
  let unsubscribe: (() => void) | undefined

  function logDiag(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19)
    debugLog.value.push(`${stamp} ${line}`)
    if (debugLog.value.length > 40) debugLog.value.shift()
  }

  const available = computed(() => useLectorium().purchases.available)
  const isSubscribed = computed(() => activePackageId.value !== undefined)

  function applyState(s: CustomerState): void {
    activePackageId.value = s.activePackageId
    managementUrl.value = s.managementUrl
  }

  async function init(): Promise<void> {
    if (ready.value) return
    const purchases = useLectorium().purchases
    logDiag(`init available=${purchases.available}`)
    if (!purchases.available) {
      ready.value = true
      return
    }
    loading.value = true
    try {
      await purchases.configure()
      logDiag("configure ok")
      const [pkgs, state] = await Promise.all([
        purchases.listPackages(),
        purchases.getCustomerState(),
      ])
      logDiag(`packages=${pkgs.length} (${pkgs.map((p) => p.packageId).join(",") || "—"})`)
      logDiag(
        `state pkg=${state.activePackageId ?? "—"} ent=${state.activeEntitlements.join(",") || "—"}`
      )
      packages.value = pkgs
      applyState(state)
      unsubscribe = purchases.onCustomerInfoChanged((s) => {
        logDiag(`live pkg=${s.activePackageId ?? "—"} ent=${s.activeEntitlements.join(",") || "—"}`)
        applyState(s)
      })
      ready.value = true
    } catch (e) {
      logDiag(`init FAILED: ${(e as Error)?.message ?? String(e)}`)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function purchase(packageId: string): Promise<void> {
    const purchases = useLectorium().purchases
    if (!purchases.available) return
    purchasing.value = true
    try {
      const state = await purchases.purchase(packageId)
      applyState(state)
    } finally {
      purchasing.value = false
    }
  }

  async function restore(): Promise<void> {
    const purchases = useLectorium().purchases
    if (!purchases.available) return
    restoring.value = true
    try {
      const state = await purchases.restore()
      applyState(state)
    } finally {
      restoring.value = false
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    ready.value = false
  }

  return {
    packages,
    activePackageId,
    managementUrl,
    loading,
    purchasing,
    restoring,
    ready,
    available,
    isSubscribed,
    debugLog,
    init,
    purchase,
    restore,
    dispose,
  }
})
