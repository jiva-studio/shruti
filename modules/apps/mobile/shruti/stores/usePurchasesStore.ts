import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
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
  let unsubscribe: (() => void) | undefined

  const available = computed(() => useShruti().purchases.available)
  const isSubscribed = computed(() => activePackageId.value !== undefined)

  function applyState(s: CustomerState): void {
    activePackageId.value = s.activePackageId
    managementUrl.value = s.managementUrl
  }

  async function init(): Promise<void> {
    if (ready.value) return
    const purchases = useShruti().purchases
    if (!purchases.available) {
      ready.value = true
      return
    }
    loading.value = true
    try {
      await purchases.configure()
      const [pkgs, state] = await Promise.all([
        purchases.listPackages(),
        purchases.getCustomerState(),
      ])
      packages.value = pkgs
      applyState(state)
      unsubscribe = purchases.onCustomerInfoChanged(applyState)
      ready.value = true
    } finally {
      loading.value = false
    }
  }

  async function purchase(packageId: string): Promise<void> {
    const purchases = useShruti().purchases
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
    const purchases = useShruti().purchases
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
    init,
    purchase,
    restore,
    dispose,
  }
})
